// The closed-loop agent's decisions, with no browser and no network in them.
//
// Everything before this ran a plan written once. Open-ended tasks - "find the cheapest flight", the
// whole of Online-Mind2Web - need the other shape: look, act, look again. That is browser-use's loop,
// and this file is ours, with the three properties the rest of the repo is built on kept intact:
//
//   - the model only ever picks from the closed action set and from ids that exist in the index it
//     was shown; anything else is rejected and costs a step, never executed as a guess
//   - every element action goes through the runner, so the gate re-checks identity in the same tick
//     as the click, and the step is recorded against a fingerprint
//   - the recorded run is an artifact: the steps that touched elements replay with no model at all
//
// The observation is deliberately small. browser-use sends a serialised DOM plus a screenshot every
// step; we send the accessibility index, a slice of visible text, and a short history. That is the
// cost argument, and whether it holds up on task success is exactly what the head-to-head measures.

export const ACTIONS = ['click', 'type', 'select', 'key', 'scroll', 'goto', 'back', 'read', 'done'];

// Keys the agent may press: enough for sliders, menus, date pickers and closing an overlay.
export const KEYS = ['Enter', 'Escape', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];

const MAX_ROWS = 250;
const MAX_TEXT = 3000;
const HISTORY = 12;

/** One index entry as the model sees it: id, role, name, and whatever state the AX tree gave us. */
export function row(entry) {
  const parts = [`[${entry.id}]`, entry.role];
  if (entry.name) parts.push(JSON.stringify(entry.name.slice(0, 80)));
  if (entry.value) parts.push(`value=${JSON.stringify(String(entry.value).slice(0, 40))}`);
  if (entry.state) parts.push(entry.state);
  if (entry.ctx) parts.push(`under ${JSON.stringify(entry.ctx.slice(0, 40))}`);
  if (entry.vp === 'above' || entry.vp === 'below') parts.push(`(${entry.vp} the viewport)`);
  return parts.join(' ');
}

export const MAX_ACTIONS = 3;

export function prompt({ task, website = '', url, title, index, text, history, memory = '', step, maxSteps, note = '' }) {
  const rows = index.slice(0, MAX_ROWS).map(row);
  const past = history.slice(-HISTORY).map((h, i) =>
    `${history.length - Math.min(history.length, HISTORY) + i + 1}. ${h.summary} -> ${h.outcome}`);
  return `You are a web agent completing a task in a real browser.

TASK: ${task}
${website ? `WEBSITE: ${website} (complete the task on this site)\n` : ''}
Current page: ${title ? `"${title}" ` : ''}${url}
Step ${step} of at most ${maxSteps}.

Interactive elements (id, role, name, state):
${rows.join('\n') || '(none found)'}
${index.length > MAX_ROWS ? `(${index.length - MAX_ROWS} more below; scroll to reach them)\n` : ''}
Visible text on the page:
${(text || '').slice(0, MAX_TEXT) || '(none)'}

Your memory from earlier steps:
${memory || '(empty)'}

Recent actions:
${past.join('\n') || '(nothing yet)'}
${note ? `\nNOTE: ${note}\n` : ''}
Reply with ONE JSON object and nothing else:
{"memory":"what you have learned and done so far that later steps need (facts found, filters applied)",
 "next_goal":"what the actions below are for",
 "actions":[ ...1 to ${MAX_ACTIONS} actions... ]}

Actions:
{"action":"click","id":"e12"}
{"action":"type","id":"e4","text":"what to type","enter":true}
{"action":"select","id":"e7","option":"visible option text"}
{"action":"key","id":"e9","key":"ArrowRight"}      (press a key on an element: sliders, menus; id optional)
{"action":"scroll","direction":"down"}            (or "up")
{"action":"goto","url":"https://..."}             (same website only)
{"action":"back"}
{"action":"read","find":"price"}                    (page text around a word; omit "find" to page through)
{"action":"done","answer":"the result, with the specific details the task asked for"}

Rules:
- Stay on the task's website. Do not use search engines or other sites; a goto to another site is refused.
- Use the site's own search box, menus, filters and sort controls, the way a person would. Do not guess
  URLs; use goto only to return to a page of this site you have already seen.
- Several actions in one reply run in order and stop early if the page changes, so chain only steps that
  belong together (type into a field, then click its search button; tick several filters).
- Use only ids from the list above. If what you need is not listed, scroll, or open the menu that holds it.
- To type into a search field that is shown as a button, click it first; the real field then appears.
- Apply every filter, sort order and option the task names. Check the element states to confirm.
- For "top", "best-selling", "most", "cheapest", "earliest" or "latest", use the site's sort control or a
  sortable column header rather than guessing from the order shown.
- Filters are often inside collapsed sections or a "Filters" / "More" button: expand them. For a slider,
  focus it and press arrow keys (or Home/End). Press Escape to close a popup that is in the way.
- Answer only with what the page shows, and finish on the page that shows it, so the result can be checked.
- When the task is complete, or it cannot be completed, use "done". The answer is all the user gets, so
  make it complete: every item the task asks for, each with its concrete details (names, prices, dates,
  ratings, counts), taken from the page, not from memory. For "browse" or "show" tasks, leave the page
  showing the result and list what it shows. Answer every part of a multi-part task.
- If the site blocks you (a CAPTCHA, "Access Denied"), say so in "done"; do not switch to another site.
- Do not repeat an action that already failed; try a different element or approach.`;
}

/** The registrable part of a hostname, near enough: the last two labels, three for a two-letter TLD pair. */
export function siteOf(url) {
  try {
    const parts = new URL(url).hostname.replace(/^www\./, '').split('.');
    const n = parts.length >= 3 && parts.at(-1).length === 2 && parts.at(-2).length <= 3 ? 3 : 2;
    return parts.slice(-n).join('.');
  } catch { return ''; }
}

/**
 * Read a whole reply: memory, goal, and up to MAX_ACTIONS actions, each validated like a single one.
 * One invalid action rejects the reply - executing the valid half of a plan the model got wrong is how
 * a half-applied filter ends up reported as done. A bare single action is accepted too.
 */
export function parseReply(text, index, { website = '' } = {}) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'empty reply' };
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { error: 'no JSON object in the reply' };
  let raw;
  try { raw = JSON.parse(match[0]); } catch { return { error: 'the JSON did not parse' }; }
  const list = Array.isArray(raw.actions) ? raw.actions : raw.action ? [raw] : null;
  if (!list || !list.length) return { error: 'no "actions" in the reply' };
  if (list.length > MAX_ACTIONS) return { error: `at most ${MAX_ACTIONS} actions per reply` };
  const actions = [];
  for (const item of list) {
    const one = parseAction(JSON.stringify(item), index);
    if (one.error) return { error: one.error };
    if (one.action.action === 'goto' && website && siteOf(one.action.url) !== siteOf(website)) {
      return { error: `goto ${one.action.url} leaves ${siteOf(website)}; stay on the task's website` };
    }
    actions.push(one.action);
  }
  const done = actions.findIndex((a) => a.action === 'done');
  return {
    actions: done === -1 ? actions : actions.slice(0, done + 1),
    memory: typeof raw.memory === 'string' ? raw.memory.slice(0, 1500) : '',
    goal: typeof raw.next_goal === 'string' ? raw.next_goal.slice(0, 300) : '',
  };
}

/**
 * Read one action out of a model reply, strictly.
 *
 * Returns `{ action }` or `{ error }`. An id not in the index shown, an unknown verb, or a missing field
 * is an error that the loop reports back to the model; it is never "fixed" into the nearest valid
 * action, because that would be the model's guess executed as if it were a decision.
 */
export function parseAction(text, index) {
  if (typeof text !== 'string') return { error: 'empty reply' };
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { error: 'no JSON object in the reply' };
  let raw;
  try { raw = JSON.parse(match[0]); } catch { return { error: 'the JSON did not parse' }; }
  const kind = String(raw.action || '').toLowerCase();
  if (!ACTIONS.includes(kind)) return { error: `unknown action "${raw.action}"` };

  const byId = new Map(index.map((e) => [e.id, e]));
  const needsId = ['click', 'type', 'select'].includes(kind) || (kind === 'key' && raw.id !== undefined && raw.id !== '');
  if (needsId) {
    const id = String(raw.id || '').replace(/^\[|\]$/g, '');
    if (!byId.has(id)) return { error: `id "${raw.id}" is not in the element list` };
    raw.id = id;
  }
  if (kind === 'type' && typeof raw.text !== 'string') return { error: 'type needs "text"' };
  if (kind === 'select' && typeof raw.option !== 'string') return { error: 'select needs "option"' };
  if (kind === 'key' && !KEYS.includes(raw.key)) return { error: `key must be one of ${KEYS.join(', ')}` };
  if (kind === 'goto' && !/^https?:\/\//.test(String(raw.url || ''))) return { error: 'goto needs an http(s) url' };
  if (kind === 'scroll' && !['up', 'down'].includes(raw.direction)) raw.direction = 'down';
  if (kind === 'done' && typeof raw.answer !== 'string') raw.answer = '';

  const action = { action: kind };
  for (const key of ['id', 'text', 'enter', 'option', 'direction', 'url', 'answer', 'find', 'key']) {
    if (raw[key] !== undefined) action[key] = raw[key];
  }
  if (needsId) action.entry = byId.get(action.id);
  return { action };
}

/** A human-readable line for the history, naming the element rather than its throwaway id. */
export function summarise(action) {
  const who = action.entry ? `${action.entry.role} "${(action.entry.name || '').slice(0, 50)}"` : '';
  switch (action.action) {
    case 'click': return `click ${who}`;
    case 'type': return `type ${JSON.stringify(action.text)} into ${who}${action.enter ? ' + Enter' : ''}`;
    case 'select': return `select ${JSON.stringify(action.option)} in ${who}`;
    case 'key': return `press ${action.key}${who ? ` on ${who}` : ''}`;
    case 'scroll': return `scroll ${action.direction}`;
    case 'goto': return `goto ${action.url}`;
    case 'back': return 'back';
    case 'read': return action.find ? `read text around ${JSON.stringify(action.find)}` : 'read page text';
    case 'done': return 'done';
    default: return action.action;
  }
}

/**
 * The same action three times running is a loop, not progress. The loop tells the model so instead of
 * letting it spend the step budget on it.
 */
export function looping(history, action, times = 3) {
  const line = summarise(action);
  const recent = history.slice(-(times - 1));
  return recent.length === times - 1 && recent.every((h) => h.summary === line);
}
