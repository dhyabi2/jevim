// The closed sets. Every slot a command can hold is a finite enumeration, which is the
// whole reason this grammar can later be handed to a model whose only output type is a
// choice over a finite enumeration. Adding a free-form slot here would break that.

/** Verbs. Always supplied by the human keystroke; a model never picks one. */
export const OPERATORS = {
  g: { id: 'goto', destructive: false, desc: 'follow or activate the target' },
  y: { id: 'yank', destructive: false, desc: 'copy the target text or href' },
  c: { id: 'change', destructive: true, desc: 'focus the target and clear it' },
  d: { id: 'dismiss', destructive: true, desc: 'hide or close the target' },
  v: { id: 'select', destructive: false, desc: 'select the target' },
};

/** Text objects, addressed as `i<char>` (inner) or `a<char>` (around). */
export const TEXT_OBJECTS = {
  p: { id: 'post', desc: 'a post, card or list item' },
  f: { id: 'form', desc: 'the enclosing form' },
  r: { id: 'row', desc: 'a table or list row' },
  a: { id: 'article', desc: 'the main article body' },
  s: { id: 'section', desc: 'the enclosing section or landmark' },
};

/** Motions that need no model at all. */
export const EDGES = {
  g: { id: 'first', desc: 'first target on the page' },
  G: { id: 'last', desc: 'last target on the page' },
  '}': { id: 'nextSection', desc: 'next section' },
  '{': { id: 'prevSection', desc: 'previous section' },
};

export const DESTRUCTIVE = new Set(
  Object.values(OPERATORS).filter((op) => op.destructive).map((op) => op.id),
);
