// Emits a comment-free, self-contained probe: the real index modules plus a measurement
// wrapper, small enough to paste into a live page for ground-truth checks.
import { readFileSync, writeFileSync } from 'node:fs';

const ORDER = ['hostile', 'visibility', 'accname', 'fingerprint', 'collect', 'serialize']
  .map((n) => `src/index/${n}.js`);

const strip = (s) => s
  .replace(/^import[\s\S]*?from\s+'[^']+';\n/gm, '')
  .replace(/^export\s+(?=(const|function|let|class))/gm, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*\*[\s\S]*?\*\//g, '')
  .replace(/\n{2,}/g, '\n');

const body = ORDER.map((p) => strip(readFileSync(p, 'utf8'))).join('\n');

writeFileSync('ext/probe.js', `window.__probe=(function(){
${body}
return function(budget){
const env=domEnv(window);const t0=performance.now();const index=collect(document,env);
const t1=performance.now();const out=serialize(index,{budget});
const bad=index.filter(e=>!isVisible(e.el,env));
const el=document.querySelectorAll('*').length;
return {url:location.hostname,domNodes:el,indexed:index.length,invisibleLeaked:bad.length,
tokens:out.tokens,budget:out.budget,kept:out.kept,dropped:out.dropped,collectMs:+(t1-t0).toFixed(1),
suspect:index.filter(e=>e.suspect).length,unnamed:index.filter(e=>!e.name).length,
sample:index.slice(0,4).map(e=>({id:e.id,fp:e.fp,role:e.role,name:e.name,ctx:e.ctx,vp:e.vp})),
leakedNode:JSON.stringify(out.state).includes('[object')};};})();`);
console.log('ext/probe.js', readFileSync('ext/probe.js','utf8').length, 'bytes');
