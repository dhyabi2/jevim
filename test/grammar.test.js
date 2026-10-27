import assert from 'node:assert/strict';
import test from 'node:test';

import { createBindings, memoryStore, motionKey } from '../src/grammar/bindings.js';
import { isEditable, tokenize } from '../src/grammar/keys.js';
import { INSERT, NORMAL, createParser } from '../src/grammar/parser.js';
import { page } from './helpers.mjs';

/** Feed a string of single-char tokens (plus `<...>` tokens) and keep every result. */
function feedAll(parser, tokens) {
  return tokens.map((token) => parser.feed(token));
}

function commands(parser, tokens) {
  return feedAll(parser, tokens)
    .filter((result) => result.status === 'command')
    .map((result) => result.command);
}

test('tokenize normalises named keys and modifiers', () => {
  assert.equal(tokenize({ key: 'd' }), 'd');
  assert.equal(tokenize({ key: 'Escape' }), '<Esc>');
  assert.equal(tokenize({ key: 'Enter' }), '<CR>');
  assert.equal(tokenize({ key: 'd', ctrlKey: true }), '<C-d>');
  assert.equal(tokenize({ key: 'Enter', ctrlKey: true }), '<C-CR>');
  assert.equal(tokenize({ key: 'Shift' }), null, 'bare modifiers are not tokens');
});

test('a bare motion runs the default goto operator', () => {
  const parser = createParser();
  assert.deepEqual(commands(parser, ['f']), [
    { count: 1, operator: 'goto', target: { kind: 'hint' } },
  ]);
});

test('operator plus motion composes, and a count prefixes it', () => {
  const parser = createParser();
  assert.deepEqual(commands(parser, ['y', 'f']), [
    { count: 1, operator: 'yank', target: { kind: 'hint' } },
  ]);
  assert.deepEqual(commands(parser, ['3', 'd', 'i', 'p']), [
    { count: 3, operator: 'dismiss', target: { kind: 'textobject', id: 'post', inner: true } },
  ]);
  assert.deepEqual(commands(parser, ['1', '2', 'y', 'a', 'r']), [
    { count: 12, operator: 'yank', target: { kind: 'textobject', id: 'row', inner: false } },
  ]);
});

test('the search motion collects a query and ends on Enter', () => {
  const parser = createParser();
  assert.deepEqual(commands(parser, ['g', '/', 'p', 'a', 'y', '<CR>']), [
    { count: 1, operator: 'goto', target: { kind: 'search', query: 'pay' } },
  ]);
});

test('backspace edits the query and an empty query is invalid, not a command', () => {
  const parser = createParser();
  feedAll(parser, ['/', 'p', 'a', 'y', '<BS>', '<BS>', '<BS>']);
  assert.deepEqual(parser.feed('<CR>'), { status: 'invalid', reason: 'empty query' });
});

test('gg reaches the first target and G the last', () => {
  const parser = createParser();
  assert.deepEqual(commands(parser, ['g', 'g']), [
    { count: 1, operator: 'goto', target: { kind: 'edge', id: 'first' } },
  ]);
  assert.deepEqual(commands(parser, ['G']), [
    { count: 1, operator: 'goto', target: { kind: 'edge', id: 'last' } },
  ]);
});

test('insert mode hands every key back to the page until Escape', () => {
  const parser = createParser();
  assert.deepEqual(parser.feed('i'), { status: 'mode', mode: INSERT });
  assert.deepEqual(parser.feed('d'), { status: 'ignored' });
  assert.deepEqual(parser.feed('f'), { status: 'ignored' });
  assert.deepEqual(parser.feed('<Esc>'), { status: 'mode', mode: NORMAL });
  assert.deepEqual(parser.feed('f').status, 'command');
});

test('Escape clears a half-typed command instead of firing it', () => {
  const parser = createParser();
  feedAll(parser, ['3', 'd']);
  assert.ok(parser.pending);
  parser.feed('<Esc>');
  assert.ok(!parser.pending);
  assert.deepEqual(commands(parser, ['f']), [
    { count: 1, operator: 'goto', target: { kind: 'hint' } },
  ]);
});

test('an unknown motion after an operator is rejected, and a stray key is passed through', () => {
  const parser = createParser();
  assert.deepEqual(parser.feed('d'), { status: 'pending' });
  assert.deepEqual(parser.feed('z'), { status: 'invalid', reason: 'no motion z' });
  assert.deepEqual(parser.feed('z'), { status: 'ignored' });
});

test('an unknown text object is rejected rather than guessed at', () => {
  const parser = createParser();
  feedAll(parser, ['d', 'i']);
  assert.deepEqual(parser.feed('z'), { status: 'invalid', reason: 'no text object z' });
});

test('macro registers parse as commands of their own', () => {
  const parser = createParser();
  assert.deepEqual(commands(parser, ['q', 'a']), [
    { count: 1, operator: 'macro-record', target: { kind: 'register', id: 'a' } },
  ]);
  assert.deepEqual(commands(parser, ['@', 'a']), [
    { count: 1, operator: 'macro-replay', target: { kind: 'register', id: 'a' } },
  ]);
  assert.deepEqual(parser.feed('q').status, 'pending');
  assert.deepEqual(parser.feed('A'), { status: 'invalid', reason: 'register must be a-z or 0-9' });
});

test('every command slot is a value from a closed set', () => {
  const parser = createParser();
  const OPERATORS = new Set(['goto', 'yank', 'change', 'dismiss', 'select', 'macro-record', 'macro-replay']);
  const KINDS = new Set(['hint', 'search', 'edge', 'textobject', 'repeat', 'register']);
  const streams = [['f'], ['y', 'f'], ['d', 'i', 'p'], ['g', 'g'], ['G'], ['c', '/', 'q', '<CR>'], ['v', 'a', 's'], ['n'], ['@', 'z']];
  for (const stream of streams) {
    for (const command of commands(parser, stream)) {
      assert.ok(OPERATORS.has(command.operator), `operator ${command.operator} escaped the set`);
      assert.ok(KINDS.has(command.target.kind), `target ${command.target.kind} escaped the set`);
      assert.equal(typeof command.count, 'number');
    }
  }
});

test('editable fields are recognised so the layer keeps out of them', () => {
  const { doc } = page(`
    <input type="text" id="t"><input type="checkbox" id="c">
    <textarea id="a"></textarea><div contenteditable="true" id="d"></div><button id="b">x</button>
  `);
  const editable = (id) => isEditable(doc.getElementById(id));
  assert.ok(editable('t'));
  assert.ok(editable('a'));
  assert.ok(editable('d'));
  assert.ok(!editable('c'));
  assert.ok(!editable('b'));
});

test('a binding is keyed by motion, survives a rewrite, and exports as a readable keymap', () => {
  const bindings = createBindings(memoryStore());
  const target = { kind: 'search', query: 'Checkout' };
  assert.equal(motionKey(target), 'search:checkout');
  assert.equal(bindings.lookup('shop.example', target), null);

  bindings.remember('shop.example', target, 'abc1234', { confidence: 0.94 });
  bindings.remember('shop.example', target, 'abc1234', { confidence: 0.97 });
  assert.equal(bindings.lookup('shop.example', target), 'abc1234');

  const keymap = bindings.toKeymap();
  assert.match(keymap, /site shop\.example/);
  assert.match(keymap, /search:checkout -> abc1234 {2}uses=2 conf=0\.97 via=user/);

  bindings.forget('shop.example', target);
  assert.equal(bindings.lookup('shop.example', target), null);
});
