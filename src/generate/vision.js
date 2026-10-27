// Vision, at authoring time only.
//
// The last thing an agent can do that a DOM index cannot: a `<canvas>` chart, a custom control drawn
// with divs and no roles, an icon button with no accessible name. To the accessibility tree those are
// either absent or a single opaque node, so no amount of better prefiltering reaches them.
//
// The answer is not to put a vision model in the hot path - that would surrender the whole latency and
// determinism argument. It is to use one ONCE, when the script is authored, and convert what it saw
// into an identity the DOM can re-find for free:
//
//   1. screenshot the viewport
//   2. ask a vision model where the described target is, as a point
//   3. ask Chrome which node is at that point
//   4. if that node is already in the index, bind to its fingerprint - nothing else is needed
//   5. if it is not (a canvas, an unlabelled div), bind to the CONTAINING node's fingerprint plus a
//      normalised offset inside it
//
// Step 5 is what makes canvas work. A point inside a canvas is not an element, so it cannot have a
// fingerprint of its own; the canvas can, and a fraction of its box survives a resize, a zoom and a
// different window than the one the script was authored on. What does not survive is the canvas
// redrawing its contents somewhere else, which is why a region binding is marked as weaker than an
// element binding and says so when it is used.

/** Ask for a point, in percentages, because no vision model is reliable in device pixels. */
export function visionPrompt({ instruction, width, height }) {
  return `Look at this screenshot of a web page, ${width} by ${height} pixels.

Find: ${instruction}

Reply with ONLY the centre of that thing as two percentages of the image, "x,y", where x is the
percentage across from the left and y is the percentage down from the top. For example: 42.5,63.1

If the thing you were asked to find is not visible in the screenshot, reply with exactly: none`;
}

/**
 * Read a point out of a model's reply.
 *
 * Deliberately tolerant about format and strict about range: a vision model asked for "42,63" will
 * sometimes answer `{"x": 42, "y": 63}`, sometimes `x=42%, y=63%`, and sometimes with a sentence around
 * it. It will never answer 4200. Returning null for anything out of range is what keeps a garbled reply
 * from being stored as a binding.
 */
export function parsePoint(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim();
  if (/^none\b/i.test(body)) return null;

  const numbers = body.match(/-?\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length < 2) return null;
  const x = Number(numbers[0]);
  const y = Number(numbers[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x > 100 || y > 100) return null;

  // Percentages, normalised. A reply of "0.42,0.63" is ambiguous with "0.42%,0.63%" and is read as
  // percentages like every other reply, because that is what was asked for.
  return { fx: x / 100, fy: y / 100 };
}

/** Where a normalised viewport point falls, in CSS pixels. */
export function toViewport({ fx, fy }, { width, height }) {
  return { x: Math.round(fx * width), y: Math.round(fy * height) };
}

/** Where a normalised offset inside a box falls, in page coordinates. */
export function inBox({ fx, fy }, box) {
  return { x: Math.round(box.x + fx * box.w), y: Math.round(box.y + fy * box.h) };
}

/** The offset of a point within a box, as fractions, clamped so a rounding error cannot escape it. */
export function offsetIn(point, box) {
  if (!box || box.w <= 0 || box.h <= 0) return null;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return { fx: clamp((point.x - box.x) / box.w), fy: clamp((point.y - box.y) / box.h) };
}

/**
 * The strength of a vision binding. An element binding replays exactly; a region binding replays a
 * click at a fraction of a box and can be wrong if the box's contents move.
 */
export const ELEMENT = 'element';
export const REGION = 'region';

/**
 * Turn "the model pointed here, and Chrome says this node is there" into a binding.
 *
 * Prefers an element binding whenever the node at the point is one the index already knows, because
 * that is an identity with a gate behind it. Falls back to a region binding on the same node, and
 * refuses rather than guessing when there is no node and no box.
 */
export function bindPoint({ point, backendNodeId, entry = null, box = null }) {
  if (entry) {
    return { kind: ELEMENT, fp: entry.fp, role: entry.role, name: entry.name, backendNodeId: entry.backendDOMNodeId };
  }
  if (!backendNodeId || !box) {
    return { kind: null, reason: 'nothing identifiable at that point' };
  }
  const offset = offsetIn(point, box);
  if (!offset) return { kind: null, reason: 'the node at that point has no box' };
  return { kind: REGION, backendNodeId, offset, box };
}

/**
 * One authoring-time identification, end to end, with the browser work injected.
 *
 * `capture`, `nodeAt`, `boxOf` and the optional `captureBox` (a screenshot of one box, for the second
 * look at a region) are supplied by the CDP side so this stays testable without a browser
 * and without a network. `ask` receives the prompt and the image and returns text.
 */
export async function identify({ instruction, capture, ask, nodeAt, boxOf, index = [], find = null,
                                  captureBox = null }) {
  const shot = await capture();
  const reply = await ask({
    prompt: visionPrompt({ instruction, width: shot.width, height: shot.height }),
    image: shot.data,
  });

  const normalised = parsePoint(reply.text);
  if (!normalised) return { found: false, reason: 'vision did not locate the target', reply: reply.text };

  const point = toViewport(normalised, shot);
  const backendNodeId = await nodeAt(point);
  if (!backendNodeId) return { found: false, reason: 'no node at the located point', point };

  // The best outcome by a distance: the thing vision found is already in the index, so it gets a real
  // fingerprint, a real gate, and repair after a redesign. Vision was only the lookup.
  const entry = (find ? find(backendNodeId) : index.find((e) => e.backendDOMNodeId === backendNodeId)) || null;
  const box = entry ? null : await boxOf(backendNodeId);
  const binding = bindPoint({ point, backendNodeId, entry, box });

  if (binding.kind !== REGION || !captureBox) {
    return binding.kind
      ? { found: true, point, ...binding, usage: reply.usage }
      : { found: false, reason: binding.reason, point };
  }

  // A region binding is only as good as the point, and a point read off a whole viewport is coarse:
  // against a real canvas chart the first answer landed 60px left of the bar it named, in the gap
  // beside its neighbour. So look again at the region alone. Cropped to the node, the target fills a
  // large part of the image, and the answer comes back already as the fraction of the node we store.
  const crop = await captureBox(box);
  const second = await ask({
    prompt: refinePrompt({ instruction, width: crop.width, height: crop.height }),
    image: crop.data,
  });
  const offset = parsePoint(second.text);
  // The first look found something; the close look says it is not in this region. Two answers that
  // disagree are not a binding, so refuse rather than keep the coarse one.
  if (!offset) return { found: false, reason: 'refinement did not locate the target in the region', point, reply: second.text };

  return {
    found: true, kind: REGION, backendNodeId, box, offset, point: inBox(offset, box), coarse: point,
    refined: true, usage: sumUsage(reply.usage, second.usage),
  };
}

/** The second look: the same question, about a crop of one element rather than the whole page. */
export function refinePrompt({ instruction, width, height }) {
  return `This image is a close-up crop of one element of a web page, ${width} by ${height} pixels.

Find: ${instruction}

Reply with ONLY the centre of that thing as two percentages of this image, "x,y", where x is the
percentage across from the left and y is the percentage down from the top. For example: 42.5,63.1

If the thing you were asked to find is not in this image, reply with exactly: none`;
}

function sumUsage(a, b) {
  if (!a && !b) return undefined;
  return { prompt_tokens: (a?.prompt_tokens || 0) + (b?.prompt_tokens || 0),
           completion_tokens: (a?.completion_tokens || 0) + (b?.completion_tokens || 0) };
}
