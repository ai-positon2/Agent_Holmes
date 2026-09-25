// Standalone backend for the Agent Holmes tools on Railway.
//
// Inside Claude's Artifact sandbox these pages call window.claude.use(...)
// for AI calls, a shared database, and file downloads. None of that exists
// once the same HTML is served from here, so this process fills in the
// pieces that genuinely need a server (the model call) — plain browser
// downloads need no backend at all, and are handled client-side instead.
"use strict";

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));
// These pages were built as Claude Artifact fragments -- Claude's own
// Artifact host wraps them in a shell that declares UTF-8 automatically.
// Served directly, there's no such wrapper and no charset anywhere, so
// browsers guess wrong on every em dash, arrow, and middle dot. Force it.
app.use(express.static(path.join(__dirname, "landing"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) res.setHeader("Content-Type", "text/html; charset=utf-8");
  },
}));

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

app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Agent Holmes server listening on " + PORT + (ANTHROPIC_API_KEY ? "" : " (ANTHROPIC_API_KEY not set -- /api/sample will 503)"));
});
