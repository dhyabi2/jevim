// A comment-free build of the same modules the extension ships, small enough to paste into
// a live page for a driven demo. Identical code path, no extra behaviour.
import { readFileSync, writeFileSync } from 'node:fs';

const ORDER = [
  'src/index/hostile.js', 'src/index/visibility.js', 'src/index/accname.js',
  'src/index/fingerprint.js', 'src/index/collect.js', 'src/index/gate.js',
  'src/index/serialize.js', 'src/grammar/grammar.js', 'src/grammar/keys.js',
  'src/grammar/parser.js', 'src/grammar/bindings.js', 'src/grammar/macros.js',
  'src/grammar/ops.js', 'src/grammar/runner.js', 'src/driver.js', 'src/hints.js',
];

const strip = (s) => s
  .replace(/^import[\s\S]*?from\s+'[^']+';\n/gm, '')
  .replace(/^export\s+(?=(const|function|let|class))/gm, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*\*[\s\S]*?\*\//g, '')
  .replace(/\n{2,}/g, '\n');

const body = ORDER.map((p) => strip(readFileSync(p, 'utf8'))).join('\n');
writeFileSync('ext/demo.js', `window.__jevimDemo=(function(){\n${body}\nreturn {collect,domEnv,createGate,createBindings,memoryStore,createOps,createRunner,createDriver,createHints,tokenize,serialize};})();`);
console.log('ext/demo.js', readFileSync('ext/demo.js', 'utf8').length, 'bytes');
