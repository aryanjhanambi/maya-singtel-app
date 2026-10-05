import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { AgentsApiError } from './agents-api.js';
import { ROOT } from './config.js';
import { ActionError, ENGINE, Run } from './run.js';

const OWNER_COOKIE = 'maya_owner';
const MAX_BODY_BYTES = 128 * 1024;
const MIN_FRAME_INTERVAL_MS = 66;
const PUBLIC_DIR = path.join(ROOT, 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/assets/maya-avatar.png': ['assets/maya-avatar.png', 'image/png'],
  '/assets/chatbot-avatar.png': ['assets/chatbot-avatar.png', 'image/png'],
};
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const hashOwner = (token) => createHash('sha256').update(token).digest('hex');

function readCookie(request, name) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ActionError(413, 'body_too_large', 'The request is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    // The parser's own message can quote the body, so it is not passed on.
    throw new ActionError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

/**
 * HTTP layer: static UI, owner-bound run routes, the UI event stream, and the
 * live browser stream with its control and input routes. `api` is null when
 * no API key is configured; the app then only reports that setup is needed.
 */
export function createApp({ config, api, journal, log = () => {}, createBrowser }) {
  const runs = new Map();
  const browserStreams = new Set();

  function send(response, status, body, headers = {}) {
    response.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    });
    response.end(body === undefined ? '' : JSON.stringify(body));
  }

  const activeRun = () => [...runs.values()].find((run) => !run.ended) ?? null;

  function ownedRun(runId, ownerHash) {
    const run = runs.get(runId);
    // A run that belongs to someone else is indistinguishable from a missing one.
    if (!run || run.ownerHash !== ownerHash) throw new ActionError(404, 'run_not_found', 'That session was not found.');
    return run;
  }

  /**
   * An earlier session of this owner that is still open on OpenAI but is not
   * live in this process: one from the hosted-browser version, or one whose
   * browser closed when the app restarted. It is only described here. It is
   * never attached to a browser and never deleted without an explicit request.
   */
  function previousSession(ownerHash) {
    const record = journal.findOpen(ownerHash);
    if (!record) return null;
    const live = runs.get(record.id);
    if (live && !live.ended) return null;
    const attempts = (record.submissions ?? record.releases ?? []).filter(
      (attempt) => !['not_submitted', 'not_delivered'].includes(attempt.status),
    );
    const last = attempts.at(-1) ?? null;
    return {
      id: record.id,
      sessionId: record.sessionId,
      engine: record.engine === ENGINE ? 'app_browser' : 'hosted_browser',
      createdAt: record.createdAt,
      codeUsed: Boolean(last),
      outcome: last ? (last.outcome ?? 'unknown') : null,
    };
  }

  /**
   * A browser is intentionally not resumed after an app restart. In the
   * consumer journey, a stale session that never submitted a code is safe to
   * keep remotely and dismiss locally, without interrupting the next visit.
   * Anything with a possible submission remains visible for an explicit
   * decision.
   */
  function availablePreviousSession(ownerHash) {
    const previous = previousSession(ownerHash);
    if (!config.demoMode || !previous || previous.codeUsed) return previous;
    journal.save({ ...journal.get(previous.id), endedAt: Date.now(), closedBy: 'dismissed' });
    return null;
  }

  function assertSameOrigin(request, port) {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(request.headers.host ?? '')) {
      throw new ActionError(403, 'bad_host', 'This app only answers on its local address.');
    }
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedHosts.some((host) => origin === `http://${host}`)) {
      throw new ActionError(403, 'cross_origin', 'Cross-origin requests are not accepted.');
    }
    if (request.headers['x-maya-request'] !== '1') {
      throw new ActionError(403, 'missing_header', 'This request did not come from the app.');
    }
  }

  async function serveStatic(response, pathname) {
    const [file, type] = STATIC_FILES[pathname];
    const content = await readFile(path.join(PUBLIC_DIR, file));
    response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type });
    response.end(content);
  }

  function openEventStream(request, response) {
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
    });
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
    const cleanups = [() => clearInterval(heartbeat)];
    request.on('close', () => cleanups.forEach((cleanup) => cleanup()));
    return cleanups;
  }

  function streamRun(request, response, run) {
    const cleanups = openEventStream(request, response);
    const write = (op) => response.write(`data: ${JSON.stringify(op)}\n\n`);
    write({ op: 'snapshot', view: run.snapshot() });
    cleanups.push(run.subscribe(write));
  }

  /**
   * The live browser: state changes as they happen, and JPEG frames from the
   * screencast, at most about fifteen a second. A frame that arrives too soon,
   * or while the connection is backed up, replaces the one waiting.
   */
  function streamBrowser(request, response, run) {
    const cleanups = openEventStream(request, response);
    let lastSent = 0;
    let waiting = null;
    let timer = null;
    const writeFrame = (frame) => {
      lastSent = Date.now();
      response.write(`data: {"t":"frame","seq":${frame.seq},"d":"${frame.data.toString('base64')}"}\n\n`);
    };
    const flush = () => {
      timer = null;
      if (!waiting) return;
      if (response.writableNeedDrain) {
        timer = setTimeout(flush, MIN_FRAME_INTERVAL_MS);
        return;
      }
      const frame = waiting;
      waiting = null;
      writeFrame(frame);
    };
    const onMessage = (message) => {
      if (message.t === 'state') {
        response.write(`data: ${JSON.stringify(message)}\n\n`);
        return;
      }
      waiting = message.frame;
      if (!timer) timer = setTimeout(flush, Math.max(0, MIN_FRAME_INTERVAL_MS - (Date.now() - lastSent)));
    };
    response.write(`data: ${JSON.stringify({ t: 'state', state: run.browserState() })}\n\n`);
    const latest = run.latestFrame();
    if (latest) writeFrame(latest);
    browserStreams.add(response);
    cleanups.push(run.subscribeBrowser(onMessage), () => clearTimeout(timer), () => browserStreams.delete(response));
  }

  async function resolvePrevious(response, ownerHash, recordId, action) {
    const previous = previousSession(ownerHash);
    if (!previous || previous.id !== recordId) throw new ActionError(404, 'not_found', 'That session was not found.');
    if (action !== 'dismiss' && action !== 'delete') throw new ActionError(400, 'invalid_action', 'Choose to keep or delete the session.');
    if (action === 'delete') {
      if (!api) throw new ActionError(503, 'not_configured', 'An API key is needed to delete the session on OpenAI.');
      try {
        await api.deleteSession(previous.sessionId);
      } catch (error) {
        // Already gone counts as deleted; anything else changes nothing.
        if (!(error instanceof AgentsApiError && error.status === 404)) {
          throw new ActionError(502, 'delete_failed', 'The session could not be deleted on OpenAI. Nothing was changed.');
        }
      }
    }
    journal.save({ ...journal.get(recordId), endedAt: Date.now(), closedBy: action === 'delete' ? 'deleted' : 'dismissed' });
    return send(response, 200, { ok: true });
  }

  async function handleApi(request, response, url) {
    const segments = url.pathname.split('/').filter(Boolean).slice(1);
    const method = request.method;
    let ownerToken = readCookie(request, OWNER_COOKIE);

    if (method === 'GET' && segments.join('/') === 'config') {
      const headers = {};
      if (!ownerToken) {
        ownerToken = randomBytes(32).toString('base64url');
        headers['Set-Cookie'] = `${OWNER_COOKIE}=${ownerToken}; Path=/; HttpOnly; SameSite=Strict`;
      }
      return send(
        response,
        200,
        {
          configured: Boolean(api),
          model: config.model,
          codeRelease: config.codeReleaseEnabled ? 'armed' : 'locked',
          fixture: config.fixtureMode,
          castOrigin: config.castOrigin,
          allowedHosts: config.allowedHosts,
          browser: 'app_chromium',
        },
        headers,
      );
    }

    if (!ownerToken) throw new ActionError(401, 'no_owner', 'Reload the page to start.');
    const ownerHash = hashOwner(ownerToken);

    if (segments[0] === 'previous' && segments.length === 2 && method === 'POST') {
      const body = await readJson(request);
      return resolvePrevious(response, ownerHash, segments[1], body.action);
    }

    if (segments[0] !== 'runs') throw new ActionError(404, 'not_found', 'Not found.');

    if (segments.length === 2 && segments[1] === 'current' && method === 'GET') {
      const run = [...runs.values()].find((candidate) => candidate.ownerHash === ownerHash && !candidate.ended);
      return send(response, 200, { run: run ? run.snapshot() : null, previous: availablePreviousSession(ownerHash) });
    }

    if (segments.length === 1 && method === 'POST') {
      if (!api) {
        throw new ActionError(
          503,
          'not_configured',
          'OPENAI_API_KEY is not configured. Add it to .env and restart the app. Nothing is simulated without it.',
        );
      }
      const existing = activeRun();
      if (existing) {
        if (existing.ownerHash !== ownerHash) {
          throw new ActionError(409, 'run_active', 'Another browser owns the active session.');
        }
        if (!existing.failed && !existing.browserLost) {
          throw new ActionError(409, 'run_active', 'End the current session first.');
        }
        // Not forced: a session with an unknown submission outcome is kept for
        // inspection until the presenter explicitly ends it.
        await existing.end();
      }
      if (availablePreviousSession(ownerHash)) {
        throw new ActionError(409, 'previous_session_open', 'An earlier session is still open. Choose to keep or delete it first.');
      }
      const run = new Run({ ownerHash, config, api, journal, log, createBrowser });
      runs.set(run.id, run);
      return send(response, 201, { run: run.snapshot() });
    }

    const run = ownedRun(segments[1], ownerHash);
    const action = segments.slice(2).join('/');

    if (method === 'GET' && action === 'stream') return streamRun(request, response, run);
    if (method === 'GET' && action === 'browser/stream') return streamBrowser(request, response, run);

    if (method === 'GET' && segments[2] === 'steps' && segments[4] === 'image' && segments.length === 5) {
      const image = run.image(segments[3]);
      if (!image) throw new ActionError(404, 'image_not_found', 'That screenshot is not available.');
      const headers = { ...SECURITY_HEADERS, 'Content-Type': 'image/jpeg' };
      if (url.searchParams.get('download') === '1') {
        headers['Content-Disposition'] = 'attachment; filename="cast-browser-screenshot.jpg"';
      }
      response.writeHead(200, headers);
      return response.end(image);
    }

    if (method === 'POST' && action === 'messages') {
      const body = await readJson(request);
      await run.postMessage(body.text, { replyTo: typeof body.replyTo === 'string' ? body.replyTo : null });
      return send(response, 202, { ok: true });
    }
    if (method === 'POST' && action === 'browser/control') {
      const body = await readJson(request);
      if (body.action === 'take') await run.takeControl();
      else if (body.action === 'return') await run.returnControl();
      else throw new ActionError(400, 'invalid_action', 'Choose take or return.');
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && action === 'browser/input') {
      const body = await readJson(request);
      await run.humanInput(body.events);
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && action === 'stop') {
      await run.stop();
      return send(response, 202, { ok: true });
    }
    if (method === 'POST' && action === 'end') {
      const body = await readJson(request);
      await run.end({ force: body.force === true });
      return send(response, 200, { ok: true });
    }
    if (method === 'POST' && action === 'reconnect') {
      await run.reconnect();
      return send(response, 202, { ok: true });
    }
    if (segments[2] === 'cards' && segments[4] === 'code' && segments.length === 5) {
      if (method === 'PUT') {
        const body = await readJson(request);
        await run.stageCode(segments[3], body.code);
        return send(response, 200, { ok: true });
      }
      if (method === 'DELETE') {
        await run.clearCode(segments[3]);
        return send(response, 200, { ok: true });
      }
    }
    throw new ActionError(404, 'not_found', 'Not found.');
  }

  const server = createServer((request, response) => {
    (async () => {
      const url = new URL(request.url, 'http://local');
      assertSameOrigin(request, server.address().port);
      if (url.pathname.startsWith('/api/')) return handleApi(request, response, url);
      if (request.method === 'GET' && STATIC_FILES[url.pathname]) return serveStatic(response, url.pathname);
      throw new ActionError(404, 'not_found', 'Not found.');
    })().catch((error) => {
      if (response.headersSent) return response.end();
      if (error instanceof ActionError) {
        return send(response, error.status, { error: { code: error.code, message: error.message } });
      }
      // Only the error class is logged: messages could quote request content.
      log('error', `request failed: ${error?.name ?? 'Error'}`);
      return send(response, 500, { error: { code: 'internal', message: 'Something went wrong in the app.' } });
    });
  });

  return {
    server,
    runs,
    browserStreams,
    async close() {
      await Promise.all([...runs.values()].map((run) => run.dispose()));
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
