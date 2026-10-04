/**
 * Typed replies to a pending card are matched here, in application code,
 * against a short exact list. The model never interprets them.
 */

const REPLIES = {
  // The sign-in request is answered by taking and returning control; typing can only decline it.
  takeover: {
    decline: ['cancel', 'no'],
  },
  release: {
    authorize: ['confirm'],
    decline: ['cancel', 'no'],
  },
};

function normalize(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[.!]$/, '');
}

/** Returns the decision for an exact reply, or null when the text is anything else. */
export function matchReply(cardKind, text) {
  const table = REPLIES[cardKind];
  if (!table) return null;
  const reply = normalize(text);
  for (const [decision, phrases] of Object.entries(table)) {
    if (phrases.includes(reply)) return decision;
  }
  return null;
}

/** Human-readable accepted replies for a card, used in app notices. */
export function acceptedReplies(cardKind) {
  return cardKind === 'release'
    ? '“confirm” or “cancel”'
    : '“cancel”, or use Take control above the browser';
}
