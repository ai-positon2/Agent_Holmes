// Pushes a pre-built {meetingDocs, budgetTracker, emails} JSON payload into
// the live Client Feedback Agent's Google mirror on Railway. The payload
// itself is gathered by a scheduled task using this project's own
// already-authorized Drive/Gmail connectors (this script has no connector
// access of its own -- it just relays a file someone else already wrote).
//
// Usage: SEED_SECRET=... node server/seed_feedback.js <path-to-payload.json> [--url <seed endpoint>]
"use strict";

const fs = require("fs");

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("Usage: node server/seed_feedback.js <path-to-payload.json> [--url <seed endpoint>]");
  process.exit(1);
}
const body = fs.readFileSync(file, "utf-8");
JSON.parse(body); // fail fast on malformed input rather than let Railway 500

const urlFlag = process.argv.indexOf("--url");
const url = urlFlag !== -1 ? process.argv[urlFlag + 1] : "https://agentholmes-production.up.railway.app/api/feedback/seed";
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
  console.log("Seeded feedback mirror ->", text);
}).catch((e) => { console.error("Seed request failed:", e); process.exit(1); });
