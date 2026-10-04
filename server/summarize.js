/**
 * One-line summaries of Agents API events for the events drawer.
 * Built from an allow-list of fields: argument values, credential values,
 * message bodies, and image data are never copied into a summary.
 */

// High-volume events that would bury the drawer. Their effect shows up in
// the item and output_text.done rows.
const SKIPPED = [
  /\.delta$/,
  /\.content_part\./,
  /\.reasoning_summary/,
  /^agent\.output\./,
];

export function isDrawerEvent(type) {
  return !SKIPPED.some((pattern) => pattern.test(type));
}

function short(text, max = 120) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function errorLabel(error) {
  if (!error || typeof error !== 'object') return '';
  return short(String(error.code ?? error.type ?? 'error'), 60);
}

function describeAction(action) {
  if (action?.type === 'computer_use_approval_request') {
    return action.request?.type ?? 'computer_use_approval_request';
  }
  if (action?.type === 'function_call') return `function_call ${short(action.name, 60)}`;
  return short(String(action?.type ?? 'unknown'), 60);
}

function describeItem(item) {
  switch (item?.type) {
    case 'message':
      return `message ${item.role ?? ''}${item.phase ? ` ${item.phase}` : ''} ${item.status ?? ''}`.trim();
    case 'function_call':
      return `function_call ${short(item.name, 60)} ${item.status ?? ''} (arguments withheld)`.trim();
    default:
      return `${short(String(item?.type ?? 'item'), 60)} ${item?.status ?? ''}`.trim();
  }
}

/** Returns a safe one-line summary for an Agents API stream event. */
export function summarizeApiEvent(event) {
  const type = event?.type ?? '';
  if (type === 'error') return `error ${errorLabel(event.error)}`;
  if (type === 'agent.session.requires_action') {
    const actions = event.session?.required_actions ?? [];
    return `${actions.length} pending: ${actions.map(describeAction).join(', ') || 'none listed'}`;
  }
  if (type === 'agent.session.failed') return `session failed ${errorLabel(event.error ?? event.session?.error)}`;
  if (type.startsWith('agent.session.environment.')) {
    return `environment ${type.split('.').pop()} ${errorLabel(event.error ?? event.environment?.error)}`.trim();
  }
  if (type.startsWith('agent.session.turn.item.')) return describeItem(event.item);
  if (type === 'agent.session.turn.output_text.done') {
    return `text complete (${typeof event.text === 'string' ? event.text.length : 0} characters)`;
  }
  if (type.startsWith('agent.session.turn.')) {
    const turn = event.turn ?? {};
    const scope = turn.subagent_id ? 'subagent turn' : 'root turn';
    return `${scope} ${short(String(turn.id ?? event.turn_id ?? ''), 40)} ${errorLabel(turn.error)}`.trim();
  }
  if (type.startsWith('agent.session.')) {
    return `session ${short(String(event.session?.id ?? event.session_id ?? ''), 40)} ${event.session?.status ?? ''}`.trim();
  }
  return '';
}
