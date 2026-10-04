import { createSseParser } from './sse.js';

/**
 * REST client for the OpenAI Agents API (beta), limited to the endpoints
 * documented in the Agents API guides. It never retries: callers decide,
 * because credential and code submissions must not be replayed.
 */

const REJECTION_STATUSES = new Set([400, 401, 403, 404, 409, 413, 422, 429]);

export class AgentsApiError extends Error {
  constructor({ status, type = null, code = null, apiMessage = null }) {
    // The API's own message is kept off `message` because it can echo input.
    super(`Agents API ${status || 'no response'}${code ? ` ${code}` : type ? ` ${type}` : ''}`);
    this.name = 'AgentsApiError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.apiMessage = apiMessage;
  }

  /**
   * True only when the response unambiguously means the request was not
   * accepted. A missing response, a timeout, a 5xx, or an unreadable 2xx can
   * all follow a request that was processed, so they are not rejections.
   */
  get rejected() {
    return REJECTION_STATUSES.has(this.status) && this.type !== 'invalid_response';
  }
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : null;
}

function toError(status, text) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON error body; status alone is reported.
  }
  const error = body && typeof body === 'object' ? (body.error ?? body) : {};
  return new AgentsApiError({
    status,
    type: identifier(error?.type) ?? 'http_error',
    code: identifier(error?.code),
    apiMessage: typeof error?.message === 'string' ? error.message.slice(0, 500) : null,
  });
}

export function createAgentsApi({ apiKey, baseUrl, fetchImpl = fetch }) {
  const auth = { Authorization: `Bearer ${apiKey}`, 'OpenAI-Beta': 'agents=v1' };
  const sessionPath = (id) => `/agents/sessions/${encodeURIComponent(id)}`;

  async function request(method, path, { body, headers = {}, timeoutMs = 30_000 } = {}) {
    let response;
    let text;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...auth,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch {
      throw new AgentsApiError({ status: 0, type: 'transport_error' });
    }
    if (!response.ok) throw toError(response.status, text);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new AgentsApiError({ status: response.status, type: 'invalid_response' });
    }
  }

  async function* readEvents(body) {
    const queue = [];
    const parser = createSseParser(({ data }) => {
      try {
        const event = JSON.parse(data);
        if (event && typeof event === 'object') queue.push(event);
      } catch {
        // Ignore keep-alives and non-JSON frames.
      }
    });
    const decoder = new TextDecoder();
    for await (const chunk of body) {
      parser.push(decoder.decode(chunk, { stream: true }));
      while (queue.length > 0) yield queue.shift();
    }
  }

  return {
    /** POST /agents/sessions. Without `input`, no task is started. */
    createSession(params) {
      return request('POST', '/agents/sessions', { body: params, timeoutMs: 60_000 });
    },

    /** GET /agents/sessions/{id}: status and current required_actions. */
    retrieveSession(sessionId) {
      return request('GET', sessionPath(sessionId));
    },

    /** POST /agents/sessions/{id}/events with input events. 202 means accepted only. */
    sendEvents(sessionId, events, { idempotencyKey } = {}) {
      return request('POST', `${sessionPath(sessionId)}/events`, {
        body: { events },
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      });
    },

    /** GET /agents/sessions/{id}/items, oldest first, following `after` cursors. */
    async *listItems(sessionId) {
      let after = null;
      for (let page = 0; page < 200; page++) {
        const query = new URLSearchParams({ order: 'asc', limit: '100' });
        if (after) query.set('after', after);
        const result = await request('GET', `${sessionPath(sessionId)}/items?${query}`);
        for (const item of result?.data ?? []) yield item;
        if (!result?.has_more || !result.last_id) return;
        after = result.last_id;
      }
    },

    /** DELETE /agents/sessions/{id}. */
    deleteSession(sessionId) {
      return request('DELETE', sessionPath(sessionId));
    },

    /**
     * GET /agents/sessions/{id}/events as text/event-stream.
     * Resolves once the stream is open (HTTP 200); the stream does not replay
     * missed events.
     */
    async openEventStream(sessionId, signal) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${sessionPath(sessionId)}/events?stream=true`, {
          headers: { ...auth, Accept: 'text/event-stream' },
          signal,
        });
      } catch {
        throw new AgentsApiError({ status: 0, type: 'transport_error' });
      }
      if (!response.ok) {
        throw toError(response.status, await response.text().catch(() => ''));
      }
      return readEvents(response.body);
    },
  };
}
