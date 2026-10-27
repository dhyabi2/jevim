// The index, built from Chrome's accessibility tree.
//
// `accname.js` is my approximation of the accessible-name computation. Chrome already implements the
// real thing, and `Accessibility.getFullAXTree` hands it over: computed roles, computed names, and the
// ignored flag that says what assistive technology would not see. It also pierces shadow roots -
// including closed ones - and cross-origin frames, which no page script can reach.
//
// This is the substantive difference from browser-use's DOM distillation: they infer semantics from the
// DOM, this reads the semantics the engine already computed.
//
// The output is the same shape `collect()` produces, so the resolver, gate, bindings and artifacts all
// work against it unchanged.

import { fingerprint } from '../src/index/fingerprint.js';
import { hadInvisibles, launder } from '../src/index/hostile.js';

// Roles a motion can address. AX roles, not tag names, so a div with role=button is included and a
// decorative anchor with no accessible name is not.
const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'spinbutton', 'listbox',
  'disclosuretriangle', 'colorwell', 'datetime', 'inputtime', 'togglebutton',
  // Sortable tables and tree navigation: "sort by blocked shots" is a click on a column header.
  'columnheader', 'treeitem',
]);

// Roles that anchor a fingerprint's ancestry. The AX equivalent of the landmark list.
const LANDMARK = new Set([
  'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'form', 'search', 'region',
  'article', 'dialog', 'table', 'grid', 'list', 'tablist', 'menu', 'menubar', 'toolbar',
]);

const HEADING = new Set(['heading']);
const MAX_ELEMENTS = 400;
const BOX_BATCH = 24;

const value = (property) => (property && property.value !== undefined ? property.value : '');

/**
 * Build the index for an open CDP page.
 *
 * Returns `{ index, axNodes, considered, viewport }`. Entries carry `backendDOMNodeId` in place of a
 * live element, because there is no DOM node on this side - acting on one goes back through CDP.
 */
export async function axIndex(page, { limit = MAX_ELEMENTS } = {}) {
  // The accessibility tree is PER FRAME. Asking once returns the main frame only, so a smoke test with
  // an iframe found the page's own buttons and missed the framed one entirely. Every frame is walked and
  // the trees merged; node ids are namespaced by frame so two frames cannot collide.
  const [frameTree, metrics] = await Promise.all([
    page.call('Page.getFrameTree'),
    page.call('Page.getLayoutMetrics'),
  ]);

  const frameIds = [];
  (function walkFrames(entry) {
    if (!entry) return;
    frameIds.push(entry.frame.id);
    for (const child of entry.childFrames || []) walkFrames(child);
  })(frameTree.frameTree);

  const nodes = [];
  for (const frameId of frameIds) {
    try {
      const tree = await page.call('Accessibility.getFullAXTree', { frameId });
      for (const node of tree.nodes || []) {
        nodes.push(frameIds.length > 1
          ? { ...node, nodeId: `${frameId}:${node.nodeId}`,
              parentId: node.parentId ? `${frameId}:${node.parentId}` : undefined,
              childIds: (node.childIds || []).map((c) => `${frameId}:${c}`),
              frameId }
          : node);
      }
    } catch { /* a frame that went away mid-walk */ }
  }

  const viewport = {
    w: metrics.cssLayoutViewport ? metrics.cssLayoutViewport.clientWidth : 1280,
    h: metrics.cssLayoutViewport ? metrics.cssLayoutViewport.clientHeight : 900,
  };

  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roleOf = (n) => String(value(n.role) || '').toLowerCase();
  const nameOf = (n) => launder(String(value(n.name) || ''));

  /** Ancestry from the AX tree: the landmark roles above this node, outermost first. */
  function chainFor(node) {
    const parts = [];
    let current = byId.get(node.parentId);
    while (current && parts.length < 4) {
      const role = roleOf(current);
      if (LANDMARK.has(role)) parts.push(role);
      current = byId.get(current.parentId);
    }
    return parts.reverse().join('>');
  }

  /** The nearest heading above this node, which is what disambiguates six identical "Edit" buttons. */
  function contextFor(node) {
    let current = byId.get(node.parentId);
    while (current) {
      for (const childId of current.childIds || []) {
        const child = byId.get(childId);
        if (child && HEADING.has(roleOf(child))) {
          const text = nameOf(child);
          if (text) return launder(text, 60);
        }
      }
      current = byId.get(current.parentId);
    }
    return '';
  }

  const considered = nodes.filter((n) => {
    if (n.ignored) return false;                       // Chrome says AT would not see it
    if (!INTERACTIVE.has(roleOf(n))) return false;
    if (!n.backendDOMNodeId) return false;
    return true;
  });

  // Geometry comes from the box model, in batches: hundreds of sequential CDP calls would dominate.
  const boxes = new Map();
  for (let i = 0; i < considered.length; i += BOX_BATCH) {
    const slice = considered.slice(i, i + BOX_BATCH);
    const results = await Promise.all(slice.map(async (n) => {
      try {
        const { model } = await page.call('DOM.getBoxModel', { backendNodeId: n.backendDOMNodeId });
        return [n.nodeId, model];
      } catch { return [n.nodeId, null]; }   // detached or not rendered
    }));
    for (const [id, model] of results) if (model) boxes.set(id, model);
  }

  const raw = [];
  for (const node of considered) {
    const model = boxes.get(node.nodeId);
    if (!model) continue;                              // no box means nothing to aim at
    const [x1, y1, , , x3, y3] = model.border;
    const width = Math.abs(x3 - x1);
    const height = Math.abs(y3 - y1);
    if (width < 3 || height < 3) continue;             // tracking pixels and clipped sr-only spans

    const name = nameOf(node);
    raw.push({
      backendDOMNodeId: node.backendDOMNodeId,
      axNodeId: node.nodeId,
      role: roleOf(node),
      name,
      ctx: contextFor(node),
      chain: chainFor(node),
      suspect: hadInvisibles(String(value(node.name) || '')),
      rect: { left: x1, top: y1, width, height },
      value: launder(String(value(node.value) || ''), 80),
      state: stateOf(node),
    });
  }

  // Reading order, then the same ranking the DOM collector uses: what is on screen first, named
  // before unnamed.
  raw.sort((a, b) => Math.round(a.rect.top / 24) - Math.round(b.rect.top / 24) || a.rect.left - b.rect.left);
  const band = (e) => (e.rect.top + e.rect.height <= 0 ? 1 : e.rect.top >= viewport.h ? 2 : 0);
  raw.sort((a, b) => band(a) - band(b) || (a.name ? 0 : 1) - (b.name ? 0 : 1));

  const seen = new Map();
  const index = raw.slice(0, limit).map((entry, i) => {
    const key = `${entry.role}|${entry.name.toLowerCase()}|${entry.chain}`;
    const ordinal = seen.get(key) || 0;
    seen.set(key, ordinal + 1);
    return {
      id: `e${i}`,
      fp: fingerprint({ role: entry.role, name: entry.name, ordinal, chain: entry.chain }),
      role: entry.role,
      name: entry.name,
      anc: entry.chain,
      ctx: entry.ctx,
      vp: bucket(entry.rect, viewport),
      suspect: entry.suspect,
      backendDOMNodeId: entry.backendDOMNodeId,
      // What a control currently says, for a reader deciding whether a filter took. Not part of the
      // fingerprint: identity must not change because a box was ticked.
      ...(entry.value ? { value: entry.value } : {}),
      ...(entry.state ? { state: entry.state } : {}),
    };
  });

  return { index, axNodes: nodes.length, considered: considered.length, viewport };
}

const STATES = ['checked', 'selected', 'expanded', 'pressed', 'disabled', 'required'];

/** The AX properties that say what a control currently is, as one short string. */
function stateOf(node) {
  const out = [];
  for (const prop of node.properties || []) {
    if (!STATES.includes(prop.name)) continue;
    const v = prop.value && prop.value.value;
    if (v === true || v === 'true') out.push(prop.name);
    else if (v === 'mixed') out.push(`${prop.name}=mixed`);
    else if ((v === false || v === 'false') && ['checked', 'expanded'].includes(prop.name)) out.push(`not ${prop.name}`);
  }
  return out.join(',');
}

function bucket(rect, viewport) {
  if (rect.top + rect.height <= 0) return 'above';
  if (rect.top >= viewport.h) return 'below';
  const col = rect.left < viewport.w / 3 ? 'l' : rect.left < (2 * viewport.w) / 3 ? 'c' : 'r';
  const row = rect.top < viewport.h / 3 ? 't' : rect.top < (2 * viewport.h) / 3 ? 'm' : 'b';
  return row + col;
}
