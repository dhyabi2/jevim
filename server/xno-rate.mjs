// Refresh the XNO (Nano) price in USD, for showing each run's cost in XNO.
//
//   node server/xno-rate.mjs        (run hourly by cron; writes $JEVIM_DATA/xno-rate.json)
//
// CoinGecko first, Kraken's NANOUSD last trade as the fallback (Binance refuses this server's location).
// The file is replaced atomically, and left alone when every source fails, so a stale rate is kept - and
// shown with its age - rather than none.

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = process.env.JEVIM_DATA || join(process.cwd(), '.data');

const SOURCES = [
  ['coingecko', async () => {
    const d = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=nano&vs_currencies=usd', { signal: AbortSignal.timeout(15000) })).json();
    return Number(d?.nano?.usd);
  }],
  ['kraken', async () => {
    const d = await (await fetch('https://api.kraken.com/0/public/Ticker?pair=NANOUSD', { signal: AbortSignal.timeout(15000) })).json();
    return Number(Object.values(d?.result || {})[0]?.c?.[0]);
  }],
];

export async function refreshRate() {
  for (const [source, get] of SOURCES) {
    try {
      const usd = await get();
      if (Number.isFinite(usd) && usd > 0) {
        const rate = { usd_per_xno: usd, source, at: new Date().toISOString() };
        writeFileSync(join(DATA, 'xno-rate.json.tmp'), JSON.stringify(rate));
        renameSync(join(DATA, 'xno-rate.json.tmp'), join(DATA, 'xno-rate.json'));
        return rate;
      }
    } catch { /* try the next source */ }
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rate = await refreshRate();
  console.log(rate ? JSON.stringify(rate) : 'no source answered; the previous rate is kept');
  process.exit(rate ? 0 : 1);
}
