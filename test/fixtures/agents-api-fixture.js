import { createServer } from 'node:http';

/**
 * A scripted local stand-in for the Agents API endpoints this app uses.
 * It exists for automated tests and the labelled UI harness. It is not
 * OpenAI and it is not CAST: nothing it returns is a real result.
 */

// A valid 1x1 JPEG, enough for the app to store and serve.
export const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

export async function startFixture({ port = 0 } = {}) {
  const state = {
    session: null,
    deleted: false,
    createBodies: [],
    requests: [],
    inputs: [],
    items: [],
    streams: new Set(),
    failNextInput: null,
    onInput: null,
    onCreate: null,
    sequence: 0,
  };

  const nextId = (prefix) => `${prefix}_fixture_${(state.sequence += 1)}`;

  function json(response, status, body) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(body === undefined ? '' : JSON.stringify(body));
  }

  async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : null;
  }

  function emit(event) {
    const frame = `data: ${JSON.stringify({ event_id: nextId('event'), ...event })}\n\n`;
    for (const stream of state.streams) stream.write(frame);
  }

  function actionMatches(action, input) {
    if (input.type === 'agent.session.input.tool_result') {
      return action.type === 'function_call' && action.call_id === input.call_id;
    }
    return action.type === 'computer_use_approval_request' && action.request_id === input.request_id;
  }

  /** Applies one input event. Returns an HTTP status. */
  function applyInput(input) {
    const session = state.session;
    if (
      input.type === 'agent.session.input.tool_result' ||
      input.type === 'agent.session.input.computer_use_approval_request_result'
    ) {
      const index = session.required_actions.findIndex((action) => actionMatches(action, input));
      if (index === -1) return 409;
      session.required_actions.splice(index, 1);
      if (session.required_actions.length === 0) session.status = 'in_progress';
    } else if (input.type === 'agent.session.input.message' && session.status === 'idle') {
      session.status = 'in_progress';
    }
    return 202;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = request.method === 'POST' ? await readBody(request) : null;
    state.requests.push({ method: request.method, path: url.pathname, headers: request.headers, body });

    if (request.headers['openai-beta'] !== 'agents=v1' || !request.headers.authorization) {
      return json(response, 400, { error: { type: 'invalid_request_error', code: 'missing_beta_header' } });
    }
    // /v1/agents/sessions[/:id[/events|items]]
    if (parts[0] !== 'v1' || parts[1] !== 'agents' || parts[2] !== 'sessions') return json(response, 404, {});

    if (parts.length === 3 && request.method === 'POST') {
      // Like the real API, a session without an environment needs initial input.
      if (body?.environment?.type === 'none' && !body.input) {
        return json(response, 400, { error: { type: 'invalid_request_error', code: 'initial_input_required' } });
      }
      state.createBodies.push(body);
      state.session = {
        id: nextId('sess'),
        object: 'agent.session',
        status: body?.input ? 'in_progress' : 'idle',
        required_actions: [],
      };
      state.deleted = false;
      // Lets a test make the first turn act before any stream is open.
      state.onCreate?.(fixture);
      return json(response, 200, state.session);
    }

    const session = state.session;
    if (!session || state.deleted || parts[3] !== session.id) {
      return json(response, 404, { error: { type: 'invalid_request_error', code: 'session_not_found' } });
    }

    if (parts.length === 4 && request.method === 'GET') return json(response, 200, session);
    if (parts.length === 4 && request.method === 'DELETE') {
      state.deleted = true;
      for (const stream of state.streams) stream.end();
      return json(response, 200, { id: session.id, object: 'agent.session.deleted', deleted: true });
    }

    if (parts[4] === 'events' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      response.write(': open\n\n');
      state.streams.add(response);
      request.on('close', () => state.streams.delete(response));
      return undefined;
    }

    if (parts[4] === 'events' && request.method === 'POST') {
      // failNextInput: { status, process? } answers with that status, having
      // applied the input first when `process` is set; { malformed } applies
      // it and answers 200 with an unreadable body; { drop } applies it and
      // closes the connection without answering.
      const failure = state.failNextInput;
      state.failNextInput = null;
      if (failure?.status && !failure.process) {
        return json(response, failure.status, { error: { type: 'server_error', code: failure.code ?? null } });
      }
      let status = 202;
      for (const input of body?.events ?? []) {
        state.inputs.push(input);
        status = Math.max(status, applyInput(input));
      }
      if (failure?.status) {
        return json(response, failure.status, { error: { type: 'server_error', code: failure.code ?? null } });
      }
      if (failure?.malformed) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end('<<not json>>');
      }
      if (failure?.drop) {
        request.socket.destroy();
        return undefined;
      }
      if (status !== 202) return json(response, status, { error: { type: 'conflict', code: 'request_not_pending' } });
      response.writeHead(202);
      response.end();
      for (const input of body?.events ?? []) await state.onInput?.(input);
      return undefined;
    }

    if (parts[4] === 'items' && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 100;
      const after = url.searchParams.get('after');
      const start = after ? state.items.findIndex((item) => item.id === after) + 1 : 0;
      const data = state.items.slice(start, start + limit);
      return json(response, 200, {
        object: 'list',
        data,
        has_more: start + limit < state.items.length,
        last_id: data.at(-1)?.id ?? null,
      });
    }
    return json(response, 404, {});
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  const fixture = {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    emit,

    /** Input events of one type received so far. */
    inputsOf(type) {
      return state.inputs.filter((input) => input.type === type);
    },

    requireAction(action) {
      state.session.required_actions.push(action);
      state.session.status = 'requires_action';
      emit({ type: 'agent.session.requires_action', session: structuredClone(state.session) });
    },

    /** Announces the current pending actions again, as after a reconnect. */
    announce() {
      emit({ type: 'agent.session.requires_action', session: structuredClone(state.session) });
    },

    /** Removes a pending action without any event, as when its turn ends. */
    dropAction(predicate) {
      state.session.required_actions = state.session.required_actions.filter((action) => !predicate(action));
    },

    originRequest(origin, { requestId = nextId('request'), turnId = 'turn_1', reason = null } = {}) {
      const action = {
        type: 'computer_use_approval_request',
        turn_id: turnId,
        request_id: requestId,
        request: { type: 'browser_origin_access', origin, reason },
      };
      fixture.requireAction(action);
      return action;
    },

    authRequest(request, { requestId = nextId('request'), turnId = 'turn_1' } = {}) {
      const action = {
        type: 'computer_use_approval_request',
        turn_id: turnId,
        request_id: requestId,
        request: { type: 'browser_authentication', reason: null, credential_origin: null, fields: [], options: [], ...request },
      };
      fixture.requireAction(action);
      return action;
    },

    functionCall(name, args, { callId = nextId('call'), turnId = 'turn_1' } = {}) {
      const action = { type: 'function_call', turn_id: turnId, call_id: callId, name, arguments: args };
      state.items.push({ type: 'function_call', id: nextId('fc'), turn_id: turnId, call_id: callId, name, arguments: args, status: 'in_progress' });
      fixture.requireAction(action);
      return action;
    },

    turnStart(turnId = 'turn_1') {
      state.session.status = 'in_progress';
      emit({ type: 'agent.session.turn.created', session_id: state.session.id, turn_id: turnId, turn: { id: turnId, subagent_id: null, status: 'in_progress' } });
    },

    turnEnd(kind = 'completed', turnId = 'turn_1', error = null) {
      state.session.status = 'idle';
      state.session.required_actions = [];
      emit({ type: `agent.session.turn.${kind}`, session_id: state.session.id, turn_id: turnId, turn: { id: turnId, subagent_id: null, status: kind, error } });
      emit({ type: 'agent.session.idle', session: structuredClone(state.session) });
    },

    /** A browser step. `image` is base64 JPEG data, or null for a step with no screenshot. */
    step({ id = nextId('cu'), turnId = 'turn_1', title = 'Browser activity', status = 'completed', image = TINY_JPEG_BASE64 } = {}) {
      const item = {
        type: 'computer_use_call',
        id,
        turn_id: turnId,
        title,
        status,
        output: image ? { type: 'computer_screenshot', image_url: `data:image/jpeg;base64,${image}` } : null,
      };
      emit({ type: 'agent.session.turn.item.added', session_id: state.session.id, turn_id: turnId, item: { ...item, status: 'in_progress', output: null } });
      emit({ type: 'agent.session.turn.item.done', session_id: state.session.id, turn_id: turnId, item });
      state.items.push(item);
      return item;
    },

    say(text, { turnId = 'turn_1', itemId = nextId('msg') } = {}) {
      const item = { type: 'message', id: itemId, turn_id: turnId, role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text }] };
      emit({ type: 'agent.session.turn.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text });
      emit({ type: 'agent.session.turn.item.done', session_id: state.session.id, turn_id: turnId, item });
      state.items.push(item);
      return item;
    },

    dropStreams() {
      for (const stream of state.streams) stream.destroy();
      state.streams.clear();
    },

    close() {
      for (const stream of state.streams) stream.destroy();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
  return fixture;
}
