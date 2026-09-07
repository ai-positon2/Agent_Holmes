// Builds the DB seed documents (meta/latest, snapshots/<date>, snapshots/<date>/clients/<slug>)
// from the existing live-artifact payload, mirroring the portfolio roll-up math in the
// current dashboard JS (solid = !ambiguous accounts).
const fs = require('fs');
const base = 'C:/Users/divith.k/AppData/Local/Temp/claude/C--Users-divith-k-AppData-Roaming-Claude-scratch-workspaces-6f993b79-92f4-41a9-ba48-4725678e13dc-48cb24ba-fef6-4216-bc11-42d669888291-scratch-2026-09-07-f7f6c1/7a4f8234-0923-4498-8a09-edb6909d0b8d/scratchpad';
const D = JSON.parse(fs.readFileSync(base + '/payload.json', 'utf-8'));

function slug(s){
  return String(s).toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,120) || 'x';
}

const A = [];
D.clients.forEach(c => c.accounts.forEach(a => { a._client = c.name; A.push(a); }));
const solid = A.filter(a => !a.ambiguous);
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const tAll = sum(solid, a => a.allocated), tSp = sum(solid, a => a.spend), tPr = sum(solid, a => a.projected);
const tCv = sum(A, a => a.conv), tMv = sum(A, a => a.moves.length);
const capped = A.filter(a => a.capped), amb = A.filter(a => a.ambiguous);
const over = A.filter(a => a.landing === 'WILL OVERSPEND'), under = A.filter(a => a.landing === 'WILL UNDERSPEND'),
      ok = A.filter(a => a.landing === 'ON TARGET');
const atRisk = sum(capped, a => a.allocated - a.projected);

const meta = {
  asOf: D.asOf, dataThrough: D.dataThrough, month: D.month, elapsed: D.elapsed,
  daysInMonth: D.daysInMonth, idealPacing: D.idealPacing, tolerance: D.tolerance,
  portfolioWarnings: D.portfolioWarnings || [],
  otherChannels: D.otherChannels || [],
  clientCount: D.clients.length, accountCount: A.length,
  tAll, tSp, tPr, tCv, tMv, atRisk,
  cappedCount: capped.length, ambiguousCount: amb.length,
  overCount: over.length, underCount: under.length, okCount: ok.length,
};

fs.writeFileSync(base + '/seed_meta.json', JSON.stringify(meta, null, 2));
fs.writeFileSync(base + '/seed_latest.json', JSON.stringify({ date: D.asOf }, null, 2));

const clientDocs = D.clients.map(c => ({ id: slug(c.name), name: c.name, data: c }));
fs.writeFileSync(base + '/seed_clients_index.json', JSON.stringify(
  clientDocs.map(c => ({ id: c.id, name: c.name, bytes: Buffer.byteLength(JSON.stringify(c.data), 'utf8') })), null, 2));

clientDocs.forEach(c => {
  fs.writeFileSync(base + '/seed_client_' + c.id + '.json', JSON.stringify(c.data));
});

console.log('meta:', JSON.stringify(meta, null, 2));
console.log('date:', D.asOf);
console.log('clients:', clientDocs.map(c => c.id));
