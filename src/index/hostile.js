// Text that reaches a decision model is attacker-controlled. Jev's own docs say state is
// not treated as hostile, so every string is laundered here before it can leave the page.

// Zero-width, bidi overrides, and other invisible codepoints used to smuggle instructions
// past a human reader while staying visible to the model.
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// A name is a label, never a paragraph. Anything longer is a payload, not a name.
export const MAX_NAME = 120;

/**
 * Normalise a user-visible string into something safe to put in model state.
 * Strips invisible and control characters, collapses whitespace, and truncates.
 */
export function launder(text, max = MAX_NAME) {
  if (typeof text !== 'string') return '';
  const cleaned = text
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + '\u2026' : cleaned;
}

/** True when the string carried characters that only a model would have seen. */
export function hadInvisibles(text) {
  return typeof text === 'string' && (INVISIBLE.test(text) || CONTROL.test(text));
}
