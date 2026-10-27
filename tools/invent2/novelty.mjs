// The novelty guard: nothing published twice, ever.
//
// Four checks, cheapest first, because a daily unattended run must not drift into republishing
// yesterday's ideas with new names.
//
//   1. the (tool, task) pair - the cursor should prevent it, but a crash mid-run could repeat one
//   2. the product name
//   3. a lexical signature: content-word overlap against every published idea
//   4. a model check against only the nearest few, which is the expensive one so it runs last
//
// The registry is the published file itself, so the guard can never disagree with what is live.

const STOP = new Set(['the','a','an','of','for','and','or','to','in','on','by','with','that','this',
  'is','are','it','its','as','from','into','each','every','any','all','so','then','than','their',
  'your','you','we','our','one','two','not','no','but','only','can','will','they','them','be','been',
  'has','have','had','was','were','do','does','did','at','if','when','which','who','what','how']);

const words = (text) => new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));

export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** A stable fingerprint of what an idea actually claims, not what it is called. */
export function signature(idea) {
  return words(`${idea.one_line} ${idea.mechanism} ${idea.standalone || ''}`);
}

/**
 * Screen candidates against everything already published.
 * Returns `{ fresh, rejected }`; each rejection says which check caught it.
 */
export async function screen(candidates, published, { judge = null, threshold = 0.42 } = {}) {
  const names = new Set(published.map((p) => norm(p.name)));
  const pairs = new Set(published.map((p) => `${norm(p.a)}|${norm(p.b)}`));
  const sigs = published.map((p) => ({ idea: p, sig: signature(p) }));

  const fresh = [];
  const rejected = [];

  for (const idea of candidates) {
    const pairKey = `${norm(idea.a)}|${norm(idea.b)}`;
    if (pairs.has(pairKey)) { rejected.push({ idea, why: 'this tool and task pair was already published' }); continue; }
    if (names.has(norm(idea.name))) { rejected.push({ idea, why: 'a published idea already has this name' }); continue; }

    const sig = signature(idea);
    const scored = sigs.map((p) => ({ ...p, score: jaccard(sig, p.sig) })).sort((a, b) => b.score - a.score);
    const nearest = scored.slice(0, 5);

    if (nearest[0] && nearest[0].score >= threshold) {
      rejected.push({ idea, why: `too close to "${nearest[0].idea.name}" (${nearest[0].score.toFixed(2)} word overlap)` });
      continue;
    }

    if (judge && nearest.length) {
      const verdict = await judge(idea, nearest.map((n) => n.idea));
      if (verdict && verdict.duplicate) {
        rejected.push({ idea, why: `judged the same idea as "${verdict.same_as || nearest[0].idea.name}": ${verdict.reason || ''}` });
        continue;
      }
    }

    // Accepting it makes it part of the registry immediately, so two fresh candidates in the same
    // batch cannot duplicate each other.
    names.add(norm(idea.name));
    pairs.add(pairKey);
    sigs.push({ idea, sig });
    fresh.push(idea);
  }

  return { fresh, rejected };
}
