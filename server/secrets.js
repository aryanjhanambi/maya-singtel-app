/**
 * Holds the CAST test code in memory only.
 *
 * A code is "staged" by the presenter, then taken exactly once when the
 * release is authorized. After that it is kept only as a redaction pattern so
 * model-written text that echoes it is not displayed. Nothing here is ever
 * serialized: the fields are private and toJSON returns an empty object.
 */

const REDACTED = '[test code]';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches the code even when separators are added or removed between characters. */
function patternFor(code) {
  const significant = [...code].filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  const chars = significant.length >= 4 ? significant : [...code];
  return new RegExp(chars.map(escapeRegExp).join('[\\s\\-_.]*'), 'giu');
}

export class CodeVault {
  #staged = null;
  #patterns = [];

  /** Validates and stages a code. Returns an error string, or null on success. */
  stage(input) {
    const code = typeof input === 'string' ? input.trim() : '';
    if (code.length < 4 || code.length > 64) return 'Enter a code between 4 and 64 characters.';
    if (/[\s\p{Cc}]/u.test(code)) return 'The code cannot contain spaces or control characters.';
    this.#staged = code;
    return null;
  }

  hasStaged() {
    return this.#staged !== null;
  }

  /** A reference safe to display: bullets, plus the last two characters of longer codes. */
  maskedReference() {
    if (this.#staged === null) return null;
    const code = this.#staged;
    return code.length >= 8
      ? `${'•'.repeat(code.length - 2)}${code.slice(-2)}`
      : '•'.repeat(code.length);
  }

  /** Returns the staged code once and keeps it only for redaction. */
  take() {
    const code = this.#staged;
    this.#staged = null;
    if (code !== null) this.#patterns.push(patternFor(code));
    return code;
  }

  clearStaged() {
    this.#staged = null;
  }

  containsStaged(text) {
    if (this.#staged === null) return false;
    return patternFor(this.#staged).test(String(text));
  }

  /** Replaces any released code in a string. Non-strings are returned unchanged. */
  redact(text) {
    if (typeof text !== 'string') return text;
    let result = text;
    for (const pattern of this.#patterns) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, REDACTED);
    }
    if (this.#staged !== null) result = result.replace(patternFor(this.#staged), REDACTED);
    return result;
  }

  destroy() {
    this.#staged = null;
    this.#patterns = [];
  }

  toJSON() {
    return {};
  }
}
