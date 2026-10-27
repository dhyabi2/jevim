// The grammar core. A pure state machine: tokens in, commands out, no DOM and no clock,
// so feeding the same token sequence twice always yields the same command sequence. The
// macro law rests entirely on that property.

import { EDGES, OPERATORS, TEXT_OBJECTS } from './grammar.js';

export const NORMAL = 'normal';
export const INSERT = 'insert';
const AWAIT_MOTION = 'await-motion';
const AWAIT_OBJECT = 'await-object';
const SEARCH = 'search';
const AWAIT_REGISTER = 'await-register';

const DEFAULT_OPERATOR = 'goto';

/**
 * Create a parser. `feed(token)` returns one of:
 *   `{ status: 'pending' }`     more keys needed
 *   `{ status: 'command', command }`
 *   `{ status: 'mode', mode }`  the layer changed mode
 *   `{ status: 'invalid', reason }`
 *   `{ status: 'ignored' }`     not ours; let the page have it
 */
export function createParser() {
  let mode = NORMAL;
  let state = NORMAL;
  let count = '';
  let operator = null;
  let inner = true;
  let query = '';
  let pendingRegister = null;

  function reset() {
    state = NORMAL;
    count = '';
    operator = null;
    inner = true;
    query = '';
    pendingRegister = null;
  }

  function emit(target) {
    const command = {
      count: count ? parseInt(count, 10) : 1,
      operator: operator || DEFAULT_OPERATOR,
      target,
    };
    reset();
    return { status: 'command', command };
  }

  function feed(token) {
    if (token === null || token === undefined) return { status: 'ignored' };

    if (token === '<Esc>') {
      const wasInsert = mode === INSERT;
      mode = NORMAL;
      reset();
      return wasInsert ? { status: 'mode', mode: NORMAL } : { status: 'pending' };
    }

    if (mode === INSERT) return { status: 'ignored' };

    switch (state) {
      case SEARCH:
        if (token === '<CR>') {
          const text = query;
          if (!text) { reset(); return { status: 'invalid', reason: 'empty query' }; }
          return emit({ kind: 'search', query: text });
        }
        if (token === '<BS>') {
          query = query.slice(0, -1);
          return { status: 'pending', query, operator: operator || DEFAULT_OPERATOR };
        }
        if (token.length === 1) {
          query += token;
          // The in-progress query is reported so the driver can prime the resolver while the
          // user is still typing. This is the whole type-ahead hook.
          return { status: 'pending', query, operator: operator || DEFAULT_OPERATOR };
        }
        return { status: 'pending', query, operator: operator || DEFAULT_OPERATOR };

      case AWAIT_OBJECT: {
        const object = TEXT_OBJECTS[token];
        if (!object) { reset(); return { status: 'invalid', reason: `no text object ${token}` }; }
        return emit({ kind: 'textobject', id: object.id, inner });
      }

      case AWAIT_REGISTER: {
        if (!/^[a-z0-9]$/.test(token)) {
          reset();
          return { status: 'invalid', reason: 'register must be a-z or 0-9' };
        }
        const action = pendingRegister;
        reset();
        return { status: 'command', command: { count: 1, operator: action, target: { kind: 'register', id: token } } };
      }

      case AWAIT_MOTION:
      case NORMAL:
      default:
        return normal(token);
    }
  }

  function normal(token) {
    // Counts: a leading 0 is not a count, it is the "first" edge in vim spirit.
    if (/^[1-9]$/.test(token) || (count && token === '0')) {
      count += token;
      return { status: 'pending' };
    }

    if (state === AWAIT_MOTION) {
      if (token === 'i' || token === 'a') {
        inner = token === 'i';
        state = AWAIT_OBJECT;
        return { status: 'pending' };
      }
      return motion(token, true);
    }

    // Top level.
    if (token === 'i') { mode = INSERT; reset(); return { status: 'mode', mode: INSERT }; }
    if (token === 'q' || token === '@') {
      pendingRegister = token === 'q' ? 'macro-record' : 'macro-replay';
      state = AWAIT_REGISTER;
      return { status: 'pending' };
    }

    if (OPERATORS[token]) {
      operator = OPERATORS[token].id;
      state = AWAIT_MOTION;
      return { status: 'pending' };
    }

    return motion(token, false);
  }

  function motion(token, afterOperator) {
    if (token === 'f') return emit({ kind: 'hint' });
    if (token === '/') { state = SEARCH; query = ''; return { status: 'pending' }; }
    if (token === 'n') return emit({ kind: 'repeat' });
    if (EDGES[token]) return emit({ kind: 'edge', id: EDGES[token].id });
    if (afterOperator) { reset(); return { status: 'invalid', reason: `no motion ${token}` }; }
    reset();
    return { status: 'ignored' };
  }

  return {
    feed,
    reset,
    get mode() { return mode; },
    setMode(next) { mode = next; reset(); },
    get pending() { return state !== NORMAL || count !== '' || operator !== null; },
  };
}
