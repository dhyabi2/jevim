// Wires the parser, the macro registers and the runner into one entry point: tokens in,
// results out. Content script and tests drive the identical object, so what the tests
// prove is what the extension does.
//
// `handle` is async because the runner is: with Jev in the hot path, a motion with no
// binding costs a network round-trip. Tokens must still be fed in order, so callers await
// each one rather than firing them in parallel.

import { createMacros } from './grammar/macros.js';
import { createParser } from './grammar/parser.js';

export function createDriver({ runner, parser = createParser(), macros = createMacros(), typeAhead = null }) {
  // Tokens seen since the last completed command. They are committed to the open macro
  // register once we know the command they formed was not itself a macro instruction.
  let pending = [];
  let replaying = false;

  function commit(discard) {
    if (!discard && macros.recording !== null && !replaying) {
      for (const token of pending) macros.capture(token);
    }
    pending = [];
  }

  async function handle(token, { confirmed = false } = {}) {
    // `q` while recording closes the register. It is vim's rule and it keeps the closing
    // keystroke out of the recording, which is what makes a replay terminate.
    if (macros.recording !== null && token === 'q' && !parser.pending) {
      pending = [];
      return { status: 'macro-stopped', register: macros.stopRecording() };
    }

    pending.push(token);
    const result = parser.feed(token);

    if (result.status !== 'command') {
      if (result.status !== 'pending') commit(false);
      // Every character of a search query is a chance to have the answer ready before <CR>.
      // Fire-and-forget: priming must never delay or break a keystroke.
      if (typeAhead && result.query && !replaying) {
        try { typeAhead.prime(result.query, runner.index(), { operator: result.operator }); }
        catch { /* a keystroke is never worth failing over */ }
      }
      return result;
    }

    const { command } = result;

    if (command.operator === 'macro-record') {
      commit(true);
      macros.startRecording(command.target.id);
      return { status: 'macro-recording', register: command.target.id };
    }

    if (command.operator === 'macro-replay') {
      commit(true);
      return replay(command.target.id);
    }

    commit(false);
    return { ...(await runner.run(command, { confirmed })), command };
  }

  async function replay(register) {
    const tokens = macros.get(register);
    if (!tokens) return { status: 'no-macro', register };
    replaying = true;
    const before = runner.net.calls;
    const results = [];
    for (const token of tokens) results.push(await handle(token));
    replaying = false;
    return { status: 'macro-replayed', register, results, netCalls: runner.net.calls - before };
  }

  return { handle, macros, parser, runner };
}
