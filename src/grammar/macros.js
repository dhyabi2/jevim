// Macros record normalised tokens, not events and not resolved targets. Replaying feeds
// the same tokens back through the same parser, so an unchanged page produces an identical
// command sequence — and, because every command in a recorded macro has already been
// resolved to an L0 binding, produces it without a single network call.

export function createMacros() {
  const registers = new Map();
  let recording = null;
  let buffer = [];

  function startRecording(register) {
    recording = register;
    buffer = [];
  }

  function stopRecording() {
    if (recording === null) return null;
    registers.set(recording, buffer.slice());
    const register = recording;
    recording = null;
    buffer = [];
    return register;
  }

  /** Called for every token the layer consumes while a recording is open. */
  function capture(token) {
    if (recording !== null) buffer.push(token);
  }

  function get(register) {
    return registers.get(register) || null;
  }

  /**
   * Replay a register by feeding its tokens to `feed`, which is the live parser+runner.
   * Returns the results in order so a caller can assert the replay matched the recording.
   */
  function replay(register, feed) {
    const tokens = get(register);
    if (!tokens) return null;
    return tokens.map((token) => feed(token));
  }

  return {
    startRecording,
    stopRecording,
    capture,
    get,
    replay,
    get recording() { return recording; },
  };
}
