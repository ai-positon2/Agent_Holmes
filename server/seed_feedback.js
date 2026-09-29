// Pushes a pre-built payload into the live Client Feedback Agent's Google
// mirror on Railway. The payload itself is gathered by a separate agent turn
// using this project's own already-authorized Drive/Gmail connectors (this
// script has no connector access of its own -- it just relays a file someone
// else already wrote). Dispatches to one or both seed routes depending on
// which keys are present: {meetingDocs, budgetTracker} -> /seed/docs (safe
// for an unattended daily job), {emails} -> /seed/emails (personal/client
// content -- only ever called from a run a person actually triggered).
//
// Usage: SEED_SECRET=... node server/seed_feedback.js <path-to-payload.json> [--url <base seed url>]
"use strict";

const fs = require("fs");

const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("Usage: node server/seed_feedback.js <path-to-payload.json> [--url <base seed url>]");
  process.exit(1);
}
const payload = JSON.parse(fs.readFileSync(file, "utf-8"));

const urlFlag = process.argv.indexOf("--url");
const baseUrl = urlFlag !== -1 ? process.argv[urlFlag + 1] : "https://agentholmes-production.up.railway.app/api/feedback/seed";
const secret = process.env.SEED_SECRET;
if (!secret) {
  console.error("SEED_SECRET env var is required (matches the Agent Holmes Railway service's SEED_SECRET).");
  process.exit(1);
}

async function post(path, body) {
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-seed-secret": secret },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(path + " failed: " + res.status + " " + text);
  return text;
}

(async () => {
  try {
    if (payload.meetingDocs !== undefined || payload.budgetTracker !== undefined) {
      const r = await post("/docs", { meetingDocs: payload.meetingDocs, budgetTracker: payload.budgetTracker });
      console.log("Seeded docs mirror ->", r);
    }
    if (payload.emails !== undefined) {
      const r = await post("/emails", { emails: payload.emails });
      console.log("Seeded email mirror ->", r);
    }
    if (payload.meetingDocs === undefined && payload.budgetTracker === undefined && payload.emails === undefined) {
      console.error("Payload has none of meetingDocs/budgetTracker/emails -- nothing to seed.");
      process.exit(1);
    }
  } catch (e) {
    console.error(String((e && e.message) || e));
    process.exit(1);
  }
})();
