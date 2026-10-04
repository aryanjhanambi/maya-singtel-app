/**
 * Minimal text/event-stream parser.
 * Calls onEvent({ event, data }) once per dispatched event.
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let data = [];
  let name = '';

  function line(text) {
    if (text === '') {
      if (data.length > 0) onEvent({ event: name || 'message', data: data.join('\n') });
      data = [];
      name = '';
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') name = value;
  }

  return {
    push(chunk) {
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === '\n') {
          line(buffer.slice(start, i));
          start = i + 1;
        } else if (ch === '\r') {
          // A trailing \r may be half of \r\n; wait for the next chunk.
          if (i + 1 === buffer.length) break;
          line(buffer.slice(start, i));
          if (buffer[i + 1] === '\n') i++;
          start = i + 1;
        }
      }
      buffer = buffer.slice(start);
    },
  };
}
