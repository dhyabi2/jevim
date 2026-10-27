// Keystrokes become tokens before anything else looks at them. A macro records tokens,
// never raw events, which is what lets a replay be byte-identical to the recording.

/** Normalise a KeyboardEvent into a stable token such as `d`, `<Esc>` or `<C-d>`. */
export function tokenize(event) {
  const named = {
    Escape: '<Esc>', Enter: '<CR>', Tab: '<Tab>', Backspace: '<BS>', ' ': '<Space>',
    ArrowUp: '<Up>', ArrowDown: '<Down>', ArrowLeft: '<Left>', ArrowRight: '<Right>',
  };
  const base = named[event.key] || event.key;
  if (base.length > 1 && !base.startsWith('<')) return null; // Shift, Meta, dead keys
  let token = base;
  if (event.ctrlKey) token = wrap('C', token);
  if (event.altKey) token = wrap('A', token);
  if (event.metaKey) token = wrap('D', token);
  return token;
}

function wrap(prefix, token) {
  const inner = token.startsWith('<') ? token.slice(1, -1) : token;
  return `<${prefix}-${inner}>`;
}

/** True when the event lands in a field the page owns, so the layer must keep its hands off. */
export function isEditable(el) {
  if (!el) return false;
  // `isContentEditable` needs a layout engine; the attribute is the portable check.
  const editableAttr = el.getAttribute && el.getAttribute('contenteditable');
  if (el.isContentEditable || editableAttr === '' || editableAttr === 'true') return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(
    (el.type || 'text').toLowerCase(),
  );
}
