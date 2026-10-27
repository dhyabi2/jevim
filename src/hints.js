// The L0 floor: Vimium-style labels. This is what a motion falls back to whenever the
// layer is not confident, which is the reason a low-confidence resolution is never a dead
// end — it degrades to the thing keyboard users already trust.

const ALPHABET = 'sadfjklewcmpgh';

/** Shortest distinct labels for `count` targets, in the classic home-row alphabet. */
export function labels(count) {
  if (count <= 0) return [];
  const chars = ALPHABET.split('');
  if (count <= chars.length) return chars.slice(0, count);
  const width = Math.ceil(Math.log(count) / Math.log(chars.length));
  const out = [];
  for (let i = 0; i < count; i++) {
    let n = i;
    let label = '';
    for (let d = 0; d < width; d++) {
      label = chars[n % chars.length] + label;
      n = Math.floor(n / chars.length);
    }
    out.push(label);
  }
  return out;
}

export function createHints(win, { onPick }) {
  const doc = win.document;
  let layer = null;
  let map = new Map();
  let typed = '';

  function show(index) {
    hide();
    layer = doc.createElement('div');
    layer.className = 'jevim-hints';
    map = new Map();
    const marks = labels(index.length);
    index.forEach((entry, i) => {
      const rect = entry.el.getBoundingClientRect();
      const mark = doc.createElement('span');
      mark.className = 'jevim-hint';
      mark.textContent = marks[i];
      mark.style.left = `${win.scrollX + rect.left}px`;
      mark.style.top = `${win.scrollY + rect.top}px`;
      layer.appendChild(mark);
      map.set(marks[i], entry);
    });
    doc.body.appendChild(layer);
    typed = '';
  }

  function hide() {
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = null;
    map = new Map();
    typed = '';
  }

  /** Returns true when the hint layer consumed the token. */
  function feed(token) {
    if (!layer) return false;
    if (token === '<Esc>') { hide(); return true; }
    if (token.length !== 1) return false;
    typed += token;
    const hit = map.get(typed);
    if (hit) { hide(); onPick(hit); return true; }
    const live = [...map.keys()].some((label) => label.startsWith(typed));
    if (!live) hide();
    return true;
  }

  return { show, hide, feed, get active() { return layer !== null; } };
}
