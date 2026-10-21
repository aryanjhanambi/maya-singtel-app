const LOOP_PHRASE = /\b(?:back\s+(?:and|&)\s+forth|round[ -]?trips?|loops?|cycles?)\b/i;
const LOOP_ACTION = /\b(?:keep|continue|repeat|loop|cycle|go|navigate|visit|open|switch|bounce|make|run)\b/i;
const UNBOUNDED = /\b(?:forever|indefinitely|nonstop|without stopping|again and again|as many times as possible)\b/i;
const COUNT = /\b(\d{1,3}|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:times|round[ -]?trips?|loops?|cycles?)\b/i;
const NEGATED = /^(?:please\s+)?(?:don't|do not|stop|avoid|prevent|never)\b|^i\s+(?:don't|do not)\s+(?:want|need)\s+(?:you\s+)?to\b/i;
const NUMBER_WORDS = new Map([
  ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
  ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15],
  ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19], ['twenty', 20],
]);

function numberValue(value) {
  return NUMBER_WORDS.get(value.toLowerCase()) ?? Number(value);
}

/**
 * Conservatively catches explicit instructions to run repetitive navigation
 * loops or deliberately consume API credits. This runs before any model call.
 */
export function isCreditWasteRequest(rawText) {
  const text = String(rawText ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (NEGATED.test(text)) return false;

  const countMatch = text.match(COUNT);
  const repeatedLoop = LOOP_PHRASE.test(text) && LOOP_ACTION.test(text) && (
    UNBOUNDED.test(text) || /\b(?:keep|continue|repeat|loop|cycle)\b/i.test(text) ||
    (countMatch && numberValue(countMatch[1]) >= 3)
  );
  const deliberateCreditUse = /\b(?:i want to|help me|please|try to|make it|do this to)\b.{0,60}\b(?:waste|burn|drain|exhaust|run through|consume)\b.{0,40}\b(?:credits?|tokens?|api usage|usage)\b/i.test(text);

  return repeatedLoop || deliberateCreditUse;
}
