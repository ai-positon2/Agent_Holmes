// Regenerates the {meta, clients, latest} seed body from out/dashboard.json
// (mirrors build_seed.js's math) and pushes it straight into the live,
// Postgres-backed Pacing Desk on Railway via POST /api/pacing/seed.
//
// Usage: SEED_SECRET=... node dashboard/seed_live.js [--url <seed endpoint>]
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(root, "out", "dashboard.json"), "utf-8"));

function slug(s) {
  return String(s).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 120) || "x";
}
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

const A = [];
D.clients.forEach((c) => c.accounts.forEach((a) => { a._client = c.name; A.push(a); }));
const solid = A.filter((a) => !a.ambiguous);
const tAll = sum(solid, (a) => a.allocated), tSp = sum(solid, (a) => a.spend), tPr = sum(solid, (a) => a.projected);
const tCv = sum(A, (a) => a.conv), tMv = sum(A, (a) => a.moves.length);
const capped = A.filter((a) => a.capped), amb = A.filter((a) => a.ambiguous);
const over = A.filter((a) => a.landing === "WILL OVERSPEND"), under = A.filter((a) => a.landing === "WILL UNDERSPEND"),
  ok = A.filter((a) => a.landing === "ON TARGET");
const atRisk = sum(capped, (a) => a.allocated - a.projected);

const meta = {
  asOf: D.asOf, dataThrough: D.dataThrough, month: D.month, elapsed: D.elapsed,
  daysInMonth: D.daysInMonth, idealPacing: D.idealPacing, tolerance: D.tolerance,
  portfolioWarnings: D.portfolioWarnings || [], otherChannels: D.otherChannels || [],
  clientCount: D.clients.length, accountCount: A.length,
  tAll, tSp, tPr, tCv, tMv, atRisk,
  cappedCount: capped.length, ambiguousCount: amb.length,
  overCount: over.length, underCount: under.length, okCount: ok.length,
};
const clients = D.clients.map((c) => ({ id: slug(c.name), data: c }));
const body = JSON.stringify({ meta, clients, latest: { date: D.asOf } });

const urlFlag = process.argv.indexOf("--url");
const url = urlFlag !== -1 ? process.argv[urlFlag + 1] : "https://agentholmes-production.up.railway.app/api/pacing/seed";
const secret = process.env.SEED_SECRET;
if (!secret) {
  console.error("SEED_SECRET env var is required (matches the Agent Holmes Railway service's SEED_SECRET).");
  process.exit(1);
}

fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-seed-secret": secret },
  body,
}).then(async (res) => {
  const text = await res.text();
  if (!res.ok) { console.error("Seed failed:", res.status, text); process.exit(1); }
  console.log("Seeded", meta.asOf, "->", text);
}).catch((e) => { console.error("Seed request failed:", e); process.exit(1); });
