// jsdom has no layout engine, so rects come from a `data-rect="x,y,w,h"` attribute and the
// measurement env reads them. Everything else (tree, attributes, selectors, computed style)
// is the real thing.

import { JSDOM } from 'jsdom';

export const VIEWPORT = { w: 1000, h: 800 };

export function page(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const doc = win.document;

  const env = {
    style: (el) => win.getComputedStyle(el),
    viewport: () => VIEWPORT,
    rect: (el) => {
      const spec = el.getAttribute('data-rect');
      const [x, y, w, h] = spec ? spec.split(',').map(Number) : [0, 0, 120, 30];
      return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h };
    },
  };

  return { dom, win, doc, env };
}
