// How the request reaches Jev. Several providers behind one shape, because the model is
// reachable more than one way and the resolver should not know or care which.
//
// The request body is TypeSafe's native `{model, state, questions}`. Providers that expose
// a systemone-compatible route take it unchanged; a chat/completions route will not, and
// says so plainly ("is a decisions model and cannot be used with the chat/completions
// endpoint"), which is why the endpoints below are the decision routes only.

export const ENDPOINTS = {
  // NanoGPT is the provider this project uses. Its /v1/systemone is compatible with
  // TypeSafe's native shape, so the request body needs no provider-specific form, and
  // /v1/decisions is equivalent. Measured ~0.66 s median round-trip from a laptop, of which
  // the model's own share is the documented 70-500 ms.
  nanogpt: 'https://nano-gpt.com/api/v1/systemone',
  // TypeSafe direct, for when the account comes off the early-access waitlist.
  typesafe: 'https://api.typesafe.ai/v1/systemone',
};

export const DEFAULT_PROVIDER = 'nanogpt';

/**
 * Build a transport. `provider` names one of ENDPOINTS, or pass `endpoint` outright.
 * The key is read from the environment by the caller and never stored by this module.
 */
export function httpTransport({ apiKey, provider = DEFAULT_PROVIDER, endpoint, timeoutMs = 20000 } = {}) {
  if (!apiKey) throw new Error('httpTransport needs an apiKey');
  const url = endpoint || ENDPOINTS[provider];
  if (!url) throw new Error(`unknown provider ${provider}`);

  return async function send(body) {
    const started = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`jev ${res.status}: ${text.slice(0, 300)}`);
    return { ...JSON.parse(text), ms: Date.now() - started };
  };
}

/** Replays a fixture. Tests use this so the suite never touches the network. */
export function recordedTransport(fixtures, { key = (body) => body.questions.target.instructions } = {}) {
  return async function send(body) {
    const hit = fixtures[key(body)];
    if (!hit) throw new Error(`no recorded answer for ${key(body)}`);
    return { ...hit, ms: hit.ms ?? 120 };
  };
}
