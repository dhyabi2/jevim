// The browser and network halves of authoring-time vision. The decisions all live in
// src/generate/vision.js, which has no browser and no network in it; this file only supplies them.

import { identify, inBox } from '../src/generate/vision.js';

const CHAT = 'https://nano-gpt.com/api/v1/chat/completions';

// Vision at $0.13 per million input tokens is why this phase stopped being too expensive to consider.
// One screenshot is on the order of a thousand tokens, so an authoring-time identification costs a
// fraction of a cent and happens once per binding, never per keystroke.
export const VISION_MODEL = 'deepseek/deepseek-v4.1-flash';

/** A vision transport: prompt plus a PNG, back as text. */
export function visionTransport({ apiKey, model = VISION_MODEL, endpoint = CHAT, timeoutMs = 90000 } = {}) {
  if (!apiKey) throw new Error('visionTransport needs an apiKey');
  return async function ask({ prompt, image }) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 64,                       // a point, not an essay
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`vision ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    return { text: body.choices?.[0]?.message?.content ?? '', usage: body.usage };
  };
}

/** Screenshot the viewport, with the size the model is being told about. */
export function capturer(page) {
  return async function capture() {
    const metrics = await page.call('Page.getLayoutMetrics');
    const view = metrics.cssVisualViewport || metrics.layoutViewport;
    const shot = await page.call('Page.captureScreenshot', { format: 'png' });
    return {
      data: shot.data,
      width: Math.round(view.clientWidth ?? view.clientWidth ?? 0) || 1280,
      height: Math.round(view.clientHeight ?? view.clientHeight ?? 0) || 800,
    };
  };
}

/**
 * Which node is at a viewport point.
 *
 * `includeUserAgentShadowDOM` is off deliberately: it would return the inner parts of a native control
 * (the thumb of a slider, the button inside a file input) rather than the control itself, and those
 * have no stable identity of their own.
 */
export function nodeLocator(page) {
  return async function nodeAt({ x, y }) {
    try {
      const out = await page.call('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: false });
      return out.backendNodeId || null;
    } catch { return null; }
  };
}

/** A node's box in page coordinates. */
export function boxer(page) {
  return async function boxOf(backendNodeId) {
    try {
      const { model } = await page.call('DOM.getBoxModel', { backendNodeId });
      const q = model.content;
      return { x: q[0], y: q[1], w: model.width, h: model.height };
    } catch { return null; }
  };
}

/**
 * A screenshot of one box, enlarged, for the second look at a region.
 *
 * Scaled so the longer side is about 800 pixels: small enough to stay a thousand-odd tokens, large
 * enough that a 90-pixel bar is a tenth of the image rather than a fifteenth of a viewport.
 */
export function boxCapturer(page, { target = 800, maxScale = 3 } = {}) {
  return async function captureBox(box) {
    const scale = Math.min(maxScale, Math.max(1, target / Math.max(box.w, box.h)));
    const shot = await page.call('Page.captureScreenshot', {
      format: 'png',
      clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale },
    });
    return { data: shot.data, width: Math.round(box.w * scale), height: Math.round(box.h * scale) };
  };
}

/**
 * Identify an element by vision and return something replayable.
 *
 * The result is either an element binding - a fingerprint, indistinguishable thereafter from one the
 * resolver produced, and no vision call ever again - or a region binding on the containing node, which
 * is how a point inside a canvas becomes storable at all.
 */
export async function identifyByVision(session, instruction, { ask, refine = true } = {}) {
  const page = session.rawPage;
  const asker = ask || visionTransport({ apiKey: process.env.NANO_API_KEY });
  return identify({
    instruction,
    capture: capturer(page),
    ask: asker,
    nodeAt: nodeLocator(page),
    boxOf: boxer(page),
    captureBox: refine ? boxCapturer(page) : null,
    index: session.index,
  });
}

/**
 * Replay a region binding: click a fraction of the way into a node's current box.
 *
 * Re-reading the box every time is the point - it is what makes the binding survive a resize or a
 * different window size than the one it was authored on.
 */
export async function clickRegion(page, binding, { click }) {
  const box = await boxer(page)(binding.backendNodeId);
  if (!box) return { clicked: false, reason: 'the region node is no longer in the document' };
  const point = inBox(binding.offset, box);
  await click(point);
  return { clicked: true, at: point, box };
}
