// Serialising the index is where the token budget is actually enforced. jev-1.13 gives 32k
// for the state plus every question, so the state gets a hard slice of that and the rest is
// left for the questions.

// Deliberately pessimistic: English averages ~4 characters per token, so dividing by 3
// means the estimate never under-reports and the budget law cannot be passed by luck.
const CHARS_PER_TOKEN = 3;

/** Conservative upper bound on the tokens a string will cost. */
export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** One index entry as a compact line. Shorter than JSON by roughly half. */
export function line(entry) {
  const parts = [entry.id, entry.role];
  if (entry.name) parts.push(JSON.stringify(entry.name));
  if (entry.ctx) parts.push('@' + JSON.stringify(entry.ctx));
  parts.push(entry.vp);
  if (entry.suspect) parts.push('!suspect');
  return parts.join(' ');
}

/**
 * Render the index as model state inside `budget` tokens, dropping from the tail (the
 * lowest-ranked entries) until it fits. Returns the state, the estimate, and what was cut.
 *
 * The live `el` node never appears in the output.
 */
export function serialize(entries, { budget = 12000 } = {}) {
  const lines = entries.map(line);
  let used = 0;
  let kept = 0;
  for (const text of lines) {
    const cost = estimateTokens(text) + 1; // +1 for the separator
    if (used + cost > budget) break;
    used += cost;
    kept += 1;
  }
  return {
    state: lines.slice(0, kept),
    tokens: used,
    kept,
    dropped: entries.length - kept,
    budget,
  };
}
