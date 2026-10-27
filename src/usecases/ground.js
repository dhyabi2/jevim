// Grounding: intent in, one element out, or a refusal with a reason.
//
// The smallest useful product in the stack, and the one an agent builder would buy: agents do
// screenshot -> LLM -> coordinates and have no way to say "I don't know". This returns a
// fingerprint, a calibrated confidence, and a refusal.

export async function ground({ resolver, index, intent, operator = 'goto' }) {
  const target = { kind: 'search', query: intent };
  const out = await resolver(target, index, { operator, target });
  if (out.abstained) {
    return { grounded: false, reason: out.reason, confidence: out.confidence ?? null,
             candidates: out.candidates ?? null, ms: out.ms ?? null };
  }
  return { grounded: true, fingerprint: out.fp, role: out.role, name: out.name,
           confidence: out.confidence, candidates: out.candidates, ms: out.ms ?? null };
}
