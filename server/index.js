// Standalone backend for the Agent Holmes tools on Railway.
//
// Inside Claude's Artifact sandbox these pages call window.claude.use(...)
// for AI calls, a shared database, and file downloads. None of that exists
// once the same HTML is served from here, so this process fills in the
// pieces that genuinely need a server (the model call) — plain browser
// downloads need no backend at all, and are handled client-side instead.
"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("./db");

const app = express();
app.use(express.json({ limit: "2mb" }));
// The Dockerfile flattens server/index.js and landing/ into the same
// directory, but `node server/index.js` run straight from a checkout
// (local dev) has landing/ as index.js's sibling one level up -- try the
// deployed layout first, fall back to the dev one.
const landingDir = fs.existsSync(path.join(__dirname, "landing"))
  ? path.join(__dirname, "landing")
  : path.join(__dirname, "..", "landing");
// These pages were built as Claude Artifact fragments -- Claude's own
// Artifact host wraps every one in a shell (doctype, charset, and a base
// reset CSS that includes "[hidden]{display:none!important}") before
// rendering it. Served directly with none of that: no charset means
// browsers guess wrong on every em dash and arrow, no doctype triggers
// Quirks Mode, and -- the one that actually breaks these pages -- with no
// "!important" forcing [hidden] to win, a page's own authored CSS (e.g.
// ".overlay{display:flex}") permanently outranks the [hidden] attribute
// per normal CSS cascade rules (author-origin beats user-agent-origin
// regardless of selector specificity). That makes anything toggled via
// `el.hidden = true/false` in JS never actually hide: the overlay looks
// stuck open even after the run underneath has long finished. Wrap every
// .html fragment in the same shell Claude's own host provides, so these
// pages render identically inside or outside the sandbox.
const ARTIFACT_SHELL_HEAD = '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>[hidden]:not([hidden=until-found i]){display:none!important}body{margin:0}</style>' +
  "</head><body>";
const ARTIFACT_SHELL_TAIL = "</body></html>";
app.use((req, res, next) => {
  if (!req.path.endsWith(".html")) { next(); return; }
  const filePath = path.join(landingDir, path.normalize(decodeURIComponent(req.path)));
  if (!filePath.startsWith(landingDir)) { next(); return; }
  fs.readFile(filePath, "utf8", (err, content) => {
    if (err) { next(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const alreadyWrapped = /^\s*<!doctype/i.test(content);
    res.send(alreadyWrapped ? content : ARTIFACT_SHELL_HEAD + content + ARTIFACT_SHELL_TAIL);
  });
});
app.use(express.static(landingDir));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// Mirrors the shape of Claude's own `sample.json(prompt, opts)`: takes a
// prompt that asks for JSON back, returns that JSON directly (not wrapped).
app.post("/api/sample", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY is not configured on this server." });
    return;
  }
  const prompt = req.body && req.body.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    res.status(400).json({ error: "Missing 'prompt' in request body." });
    return;
  }
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        system: "Reply with ONLY valid JSON matching exactly what the user asks for. No prose, no markdown code fences, no explanation before or after the JSON.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      res.status(502).json({ error: "Anthropic API error " + upstream.status, detail: detail.slice(0, 500) });
      return;
    }
    const data = await upstream.json();
    const raw = (data.content || []).map((b) => b.text || "").join("").trim();
    const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: "Model did not return valid JSON.", raw: raw.slice(0, 500) });
      return;
    }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Pacing Desk's data layer -- a REST stand-in for the Claude Artifact's
// shared `db` capability, backed by the Postgres tables in ./db.js.
function requireDb(_req, res, next) {
  if (!db.pool) {
    res.status(503).json({ error: "DATABASE_URL is not configured on this server." });
    return;
  }
  next();
}
function onDbError(res) {
  return (e) => res.status(500).json({ error: String((e && e.message) || e) });
}

app.get("/api/pacing/snapshots", requireDb, (req, res) => {
  db.listSnapshots().then((rows) => res.json(rows), onDbError(res));
});

app.get("/api/pacing/snapshots/:date/meta", requireDb, (req, res) => {
  db.getSnapshotMeta(req.params.date).then((meta) => {
    if (!meta) { res.status(404).json({ error: "No snapshot for that date." }); return; }
    res.json(meta);
  }, onDbError(res));
});

app.get("/api/pacing/snapshots/:date/clients", requireDb, (req, res) => {
  db.getSnapshotClients(req.params.date).then((rows) => res.json(rows), onDbError(res));
});

app.get("/api/pacing/meta/latest", requireDb, (req, res) => {
  db.getLatest().then((latest) => {
    if (!latest) { res.status(404).json({ error: "No latest snapshot recorded yet." }); return; }
    res.json(latest);
  }, onDbError(res));
});

app.get("/api/pacing/moves", requireDb, (req, res) => {
  const date = req.query.date;
  if (typeof date !== "string" || !date) { res.status(400).json({ error: "Missing 'date' query param." }); return; }
  db.listMoves(date).then((rows) => res.json(rows), onDbError(res));
});

app.put("/api/pacing/moves/:id", requireDb, (req, res) => {
  db.upsertMove(req.params.id, req.body || {}).then(() => res.json({ ok: true }), onDbError(res));
});

// Fail-closed: with no SEED_SECRET set, this route refuses every request
// rather than accepting writes from anyone who finds the (public) repo.
const SEED_SECRET = process.env.SEED_SECRET;
app.post("/api/pacing/seed", requireDb, (req, res) => {
  if (!SEED_SECRET || req.get("x-seed-secret") !== SEED_SECRET) {
    res.status(403).json({ error: "Forbidden." });
    return;
  }
  db.seedDay(req.body || {}).then(() => res.json({ ok: true }), onDbError(res));
});

require("./feedback")(app, db);

app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Agent Holmes server listening on " + PORT + (ANTHROPIC_API_KEY ? "" : " (ANTHROPIC_API_KEY not set -- /api/sample will 503)"));
});
// Runs in the background -- an unreachable or misconfigured DATABASE_URL
// must not block the port from opening, since a hung connection attempt
// has no timeout by default and would otherwise take the whole app down.
db.ensureSchema().catch((e) => console.error("Pacing Desk: schema init failed", e));
