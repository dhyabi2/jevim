// The artifact: a motion script.
//
// This is the thing the whole product sells. An LLM authors it once, it replays without any
// model, it is addressed by fingerprints rather than CSS selectors, and it is text a person
// can read and diff in review. Every use case above it - tests, workflows, form fills -
// is a different reader of this same format.
//
// Format (one step per line, comments with #):
//
//   # checkout flow
//   goto  search:"proceed to checkout"  fp=1a2b3c4  role=link  name="Proceed to checkout"  conf=0.94
//   type  search:"card number"          value=$CARD
//   goto  edge:last
//
// A pinned step carries `role` and `name` as well as the fingerprint. Without them the artifact is not
// repairable: after a redesign the fingerprint is simply absent from the page and there is nothing left
// to describe, so the step can only fail. Carrying them also makes the script readable - a reviewer can
// see what each line targets without running it.
//
// A step is a verb from the closed operator set plus a target from the closed motion set,
// optionally pinned to the fingerprint it resolved to last time. Pinned steps replay with no
// network at all; unpinned ones resolve through L1 on first run and get pinned.

import { OPERATORS, TEXT_OBJECTS } from './grammar/grammar.js';

const VERBS = new Set([...Object.values(OPERATORS).map((o) => o.id), 'type', 'assert']);

/** Parse a target expression such as `search:"pay now"`, `object:i:post`, `edge:first`. */
export function parseTarget(text) {
  const [kind, ...rest] = text.split(':');
  const arg = rest.join(':');
  if (kind === 'search') {
    const match = arg.match(/^"(.*)"$/);
    return { kind: 'search', query: match ? match[1] : arg };
  }
  if (kind === 'object') {
    const [inner, id] = arg.split(':');
    if (!TEXT_OBJECTS[id] && !Object.values(TEXT_OBJECTS).some((o) => o.id === id)) {
      throw new Error(`unknown text object ${id}`);
    }
    return { kind: 'textobject', id, inner: inner === 'i' };
  }
  if (kind === 'edge') return { kind: 'edge', id: arg };
  if (kind === 'hint') return { kind: 'hint' };
  throw new Error(`unknown target kind ${kind}`);
}

export function formatTarget(target) {
  switch (target.kind) {
    case 'search': return `search:"${target.query}"`;
    case 'textobject': return `object:${target.inner ? 'i' : 'a'}:${target.id}`;
    case 'edge': return `edge:${target.id}`;
    default: return target.kind;
  }
}

/**
 * Parse a script into steps. Throws on anything outside the closed sets, which is what makes
 * a generated script safe to accept: an LLM cannot invent a verb here, only choose one.
 */
export function parse(text) {
  const steps = [];
  const meta = { name: null, url: null };
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.match(/^#\s*(name|url):\s*(.+)$/);
      if (m) meta[m[1]] = m[2].trim();
      continue;
    }
    const [verb, targetText, ...tail] = tokenise(line);
    if (!VERBS.has(verb)) throw new Error(`line ${i + 1}: unknown verb ${verb}`);
    const step = { verb, target: parseTarget(targetText) };
    for (const token of tail) {
      const [key, ...v] = token.split('=');
      const value = v.join('=');
      if (key === 'fp') step.fp = value;
      else if (key === 'conf') step.confidence = Number(value);
      else if (key === 'value') step.value = value;
      else if (key === 'expect') step.expect = value;
      else if (key === 'role') step.role = value;
      else if (key === 'name') step.name = value.replace(/^"|"$/g, '');
    }
    steps.push(step);
  }
  return { meta, steps };
}

// Splitting on whitespace would tear `search:"proceed to payment"` into three tokens, so
// quoted runs are kept whole.
function tokenise(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; current += ch; continue; }
    if (!inQuotes && /\s/.test(ch)) { if (current) { out.push(current); current = ''; } continue; }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/** Render steps back to text. Round-trips with `parse`. */
export function format({ meta = {}, steps }) {
  const lines = [];
  if (meta.name) lines.push(`# name: ${meta.name}`);
  if (meta.url) lines.push(`# url: ${meta.url}`);
  for (const step of steps) {
    const parts = [step.verb.padEnd(6), formatTarget(step.target)];
    if (step.value !== undefined) parts.push(`value=${step.value}`);
    if (step.expect !== undefined) parts.push(`expect=${step.expect}`);
    if (step.fp) parts.push(`fp=${step.fp}`);
    if (step.role) parts.push(`role=${step.role}`);
    if (step.name) parts.push(`name=${JSON.stringify(step.name)}`);
    if (step.confidence !== undefined && step.confidence !== null) parts.push(`conf=${step.confidence.toFixed(2)}`);
    lines.push(parts.join('  '));
  }
  return lines.join('\n') + '\n';
}

/** True when every step is pinned, so the script replays with no model call at all. */
export function isPinned({ steps }) {
  return steps.every((step) => Boolean(step.fp) || step.target.kind === 'edge');
}

export { VERBS };
