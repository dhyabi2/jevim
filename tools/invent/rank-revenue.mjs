// Rank the verified inventions by expected return.
//
// EVERY NUMBER HERE IS MY ESTIMATE. None was measured and none came from a market report. The
// model is written down so the assumptions can be argued with and changed, which is the only
// honest way to present a ranking like this.
//
// Gross margin is deliberately NOT a ranking factor. A decision costs $0.000077 and the cheapest
// thing here sells for $0.005, so every single one of the 110 has a 90%+ gross margin. Margin
// does not discriminate between them. What discriminates is: how big a cheque the buyer already
// writes, whether a regulator forces them to do the work at all, how crowded the field is, and
// how long before the first payment.

import { readFileSync, writeFileSync } from 'node:fs';

// acv: my estimate of annual contract value per customer, in $k, for a mid-market buyer.
// compel: is the buyer legally required to do this work at all? 1 = no, 5 = a regulator audits it.
// budget: does a line item already exist that this comes out of? 1 = no, 5 = yes and it is large.
// crowd: how contested. 1 = empty, 5 = dozens of funded competitors.
// months: my estimate of sales cycle to first paid contract.
// reach: how many customers a focused team could plausibly close in three years.
const DOMAIN = {
  'KYC and AML case review':            { acv: 600, compel: 5, budget: 5, crowd: 4, months: 12, reach: 12 },
  'insurance claims adjudication':      { acv: 700, compel: 4, budget: 5, crowd: 4, months: 15, reach: 8 },
  'medical coding':                     { acv: 400, compel: 4, budget: 5, crowd: 3, months: 9,  reach: 20 },
  'credit underwriting on thin files':  { acv: 350, compel: 5, budget: 4, crowd: 3, months: 12, reach: 12 },
  'e-discovery review':                 { acv: 300, compel: 5, budget: 5, crowd: 4, months: 6,  reach: 25 },
  'SOC alert triage':                   { acv: 300, compel: 3, budget: 5, crowd: 5, months: 9,  reach: 15 },
  'financial reconciliation and close': { acv: 250, compel: 3, budget: 5, crowd: 4, months: 9,  reach: 25 },
  'patent prior-art search':            { acv: 200, compel: 3, budget: 3, crowd: 3, months: 9,  reach: 12 },
  'RPA upkeep':                         { acv: 200, compel: 2, budget: 5, crowd: 3, months: 9,  reach: 18 },
  'contract review and redlining':      { acv: 150, compel: 2, budget: 4, crowd: 5, months: 6,  reach: 30 },
  'invoice and AP exception handling':  { acv: 150, compel: 2, budget: 4, crowd: 4, months: 6,  reach: 30 },
  'E2E test maintenance':               { acv: 90,  compel: 1, budget: 4, crowd: 4, months: 3,  reach: 60 },
  'browser automation and navigation':  { acv: 60,  compel: 1, budget: 3, crowd: 4, months: 2,  reach: 80 },
};

// Ideas where I judged the differentiation to be unusually sharp: the mechanism produces exactly
// the number the buyer is measured on, or exactly the artifact a regulator demands.
const SHARP = {
  CodaMatch: 'produces the two numbers a CDI director is measured on: revenue not captured, and audit exposure',
  LddClaim: 'the transitive policy-endorsement-exclusion closure IS coverage determination',
  ChainCredit: 'emits the adverse-action reason at the deciding step, which ECOA requires and rule engines do not give',
  KYCDeptree: 'beneficial-ownership chains, the known-hard part of KYC',
  CommRecon: 'matched / source-only / target-only IS reconciliation, with no rules to configure first',
  ReconDiff: 'generates the correcting journal entries instead of flagging the discrepancy',
  'Contract Fsck': 'semantic self-consistency of one document; I could name no product that does it',
  LddDiscovery: 'family-production completeness, which is where sanctions come from',
  TeeLedger: 'makes the close continuous rather than a month-end event',
  AlertFsck: 'names the context that is missing rather than enriching what is present',
  CommScore: 'three-way thin-file segmentation instead of one score',
  FsckDiscovery: 'population-level gaps: missing attachments, broken threads, holes in a date range',
  SedTest: 'reviewable substitution against healing that silently guesses and greens a broken build',
  PermissionProfile: 'agent authority at element granularity, which nothing offers',
  AlertRank: 'groups alerts by behaviour rather than entity name, which is what surfaces the real offenders',
  'Contract Dependency': 'what a contract incorporates by reference, transitively',
};

const w1 = JSON.parse(readFileSync('.ledger/invent/prefiltered.json', 'utf8'));
const w2 = JSON.parse(readFileSync('.ledger/invent/wave2.json', 'utf8'));
const byId = new Map([...w1, ...w2].map((x) => [x.id, x]));
const verdicts = {};
for (const f of ['verdicts-001', 'verdicts-002', 'verdicts-003', 'verdicts-004']) {
  Object.assign(verdicts, JSON.parse(readFileSync(`.ledger/invent/${f}.json`, 'utf8')));
}
const accepted = Object.entries(verdicts)
  .filter(([, v]) => v.v === 'accept').map(([id]) => byId.get(id)).filter(Boolean);

const scored = accepted.map((idea) => {
  const d = DOMAIN[idea.b];
  const sharp = SHARP[idea.name] ? 1.6 : 1.0;
  // Compulsion and an existing budget multiply; crowding and a long cycle divide.
  const score = d.acv * sharp * (d.compel / 5) * (d.budget / 5)
              * ((6 - d.crowd) / 5) / Math.sqrt(d.months / 6);
  // Three-year ARR band: sharp ideas win more of the reachable set, crowded fields fewer.
  const share = (sharp === 1.6 ? 0.55 : 0.28) * ((6 - d.crowd) / 5);
  const customers = Math.max(1, Math.round(d.reach * share));
  return { ...idea, score, acv: d.acv, customers, arr: (d.acv * customers) / 1000,
           compel: d.compel, crowd: d.crowd, months: d.months, sharp: Boolean(SHARP[idea.name]),
           note: SHARP[idea.name] || '' };
});

scored.sort((a, b) => b.score - a.score);
writeFileSync('.ledger/invent/ranked.json', JSON.stringify(scored, null, 1));

console.log('rank name | domain | ACV$k | 3yr ARR $m | compel | crowd | cycle');
scored.slice(0, 30).forEach((s, i) => {
  console.log(`${String(i + 1).padStart(2)} ${s.name} | ${s.b.slice(0, 26)} | ${s.acv} | ${s.arr.toFixed(1)} | ${s.compel} | ${s.crowd} | ${s.months}mo${s.sharp ? ' *' : ''}`);
});
const tiers = [[0, 16], [16, 45], [45, 80], [80, 110]];
console.log('\ntier totals (3yr ARR $m):');
for (const [a, b] of tiers) {
  const slice = scored.slice(a, b);
  console.log(`  ${a + 1}-${b}: ${slice.reduce((s, x) => s + x.arr, 0).toFixed(0)}`);
}
