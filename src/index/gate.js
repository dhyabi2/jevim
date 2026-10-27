// The atomic fingerprint gate.
//
// The index is rebuilt lazily, so time passes between resolving a motion to an element and
// acting on it: a mutation, a confirmation prompt, an await. In that window an L0 binding
// can come to point at a node that has moved, changed name, or left the document, and the
// action fires on the wrong element with no error at all. Silent, and worst on exactly the
// dynamic pages where bindings are most valuable.
//
// So the identity is re-checked in the same tick as the action, against the live DOM.

import { accessibleName, roleOf } from './accname.js';
import { ancestry } from './fingerprint.js';
import { isVisible } from './visibility.js';
import { shift } from './walk.js';

/**
 * Build the gate for a document. Returns `(entry) => { ok, reason }`, where `entry` is an
 * index entry carrying the role, name and ancestry recorded when it was collected.
 *
 * Ordinal is deliberately not re-checked: it is a property of the whole collection, not of
 * the element, and recomputing it would mean a second full pass at the moment of action.
 * A stale ordinal is already handled by the resolver, which forgets a binding whose
 * fingerprint is absent from the current index.
 */
export function createGate(doc, env) {
  return function gate(entry) {
    const el = entry.el;
    // `isConnected` and not `doc.contains`: an element inside a shadow root or a frame is connected
    // but is NOT contained by the top-level document, so containment rejected every element behind a
    // boundary as having left the page.
    if (!el || !el.isConnected) {
      return { ok: false, reason: 'target left the document' };
    }
    // Frame rects are relative to the frame, so the same shift the collector used is reapplied here.
    const local = shift(env, entry.offset);
    if (!isVisible(el, local)) return { ok: false, reason: 'target is no longer visible' };
    if (roleOf(el) !== entry.role) return { ok: false, reason: 'target role changed' };
    // Names resolve in the element's own document, exactly as they did when it was collected.
    const owner = el.ownerDocument || doc;
    if (accessibleName(el, owner) !== entry.name) return { ok: false, reason: 'target name changed' };
    const chain = [...(entry.boundary || []), ...ancestry(el)].join('>');
    if (chain !== entry.anc) return { ok: false, reason: 'target moved' };
    return { ok: true, reason: '' };
  };
}
