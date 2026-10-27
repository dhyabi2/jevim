// Is a renamed element still the element that was chosen?
//
// The gate re-reads an element's accessible name immediately before acting, and used to refuse on any
// difference. Real pages rename their own controls constantly without becoming something else: a
// "5 stars" filter gains a count, "Cart" becomes "Cart 2 items", a timestamp ticks. On the benchmark
// the agent retried such a button until its steps ran out. What the gate exists to catch is a DIFFERENT
// element under the cursor - "Buy" becoming "Delete account" - and that must still be refused.
//
// So names match when they are equal once digits, case, punctuation and spacing are ignored, or when
// one extends the other by a word or two at a word boundary. Anything else is a different element.

function normalise(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[0-9]+([.,][0-9]+)*/g, ' ')
    .replace(/[^\p{L}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameName(before, after) {
  if (before === after) return true;
  const a = normalise(before);
  const b = normalise(after);
  if (a === b) return a.length > 0 || String(before).trim() === String(after).trim();
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // Extension at a word boundary, from a name long enough to mean something, by at most two words:
  // "Cart" -> "Cart 2 items" is a counter; "Accept" -> "Accept all and delete my data" is not.
  if (short.length < 3) return false;
  const extra = long.startsWith(`${short} `) ? long.slice(short.length + 1)
    : long.endsWith(` ${short}`) ? long.slice(0, long.length - short.length - 1) : null;
  return extra !== null && extra.split(' ').length <= 2;
}
