# Plan: Agent Holmes standalone backend (Railway)

**Asked:** 2026-09-25. The three tools linked from Agent Desk (SQR Agent,
Pacing Desk, Client Feedback Agent) were built as Claude Artifacts and lean
on `window.claude.use(...)` for AI calls, a shared database, file downloads,
and MCP connector access (Slack/Drive/Gmail). None of that exists once the
static HTML is served from Railway instead of claude.ai's Artifact sandbox.
Goal: give Railway a real backend so all three work standalone, for
teammates who don't have access to the private Claude Artifacts.

## Why this is bigger than the earlier Railway fix
The Dockerfile fix (Sept 25) made Railway *serve* the files. It didn't make
the *features* work — those were never static-site problems, they're
missing-capability problems. Every `window.claude.use("X")` call needs a
real replacement:

| Capability | Used by | Replacement |
|---|---|---|
| `downloads` | SQR Agent (.xlsx export) | Plain `<a download>` / Blob URL — no backend needed, only needed a sandbox workaround inside Claude |
| `sample` (Claude calls) | SQR Agent (ambiguous-term classification), Client Feedback Agent (summarization) | Backend route that calls the real Anthropic API with a server-held key |
| `db` (shared/live data) | Pacing Desk (`snapshots/<date>`, `snapshots/<date>/clients/<slug>`, `meta/latest`, `moves/<id>`) | Real database (Postgres via Railway addon, or SQLite on a persistent volume) + REST endpoints mirroring that shape |
| `mcp` (Slack/Drive/Gmail) | Client Feedback Agent | Real OAuth apps for Slack and Google, backend routes that call their APIs directly |

## Architecture
One Node.js (Express) service, replacing the current plain-file Dockerfile:
- Serves `landing/*.html` as static files (same as now).
- `POST /api/sample` — proxies a prompt to the Anthropic API. Used by both
  SQR Agent and Client Feedback Agent instead of `window.claude.use("sample")`.
- Pacing Desk routes: `GET /api/pacing/snapshots`, `GET /api/pacing/snapshots/:date`,
  `GET /api/pacing/meta/latest`, `POST /api/pacing/moves/:id` — same shape as
  the current Artifact DB collections, backed by a real database instead.
  The existing daily-refresh pipeline (`run.py` -> `export_dashboard.py`)
  gets a new step that POSTs its output here instead of (or in addition to)
  writing to the Claude Artifact's `db`.
- Client Feedback Agent routes: OAuth start/callback for Slack and Google,
  a search endpoint that queries Slack search + Drive + Gmail APIs, and a
  summarize endpoint that calls `/api/sample`.
- Each page's front-end JS swaps its `window.claude.use(...)` calls for
  `fetch()` calls to these routes, gated behind a `location.hostname` check
  (or a small shim) so the SAME html files still work unmodified when
  published back to claude.ai as Artifacts — this must not break the
  Artifact versions, which the user still uses directly today.

## Hard constraints
- `ai-positon2/Agent_Holmes` is a **public** repo. The Anthropic API key and
  both OAuth client secrets must live only in Railway environment variables,
  never committed to any file.
- I cannot push to the `holmes` remote (blocked by the Claude Code auto-mode
  classifier) or touch the Railway dashboard/env vars directly. Every change
  goes: I push to `origin` -> user pushes `origin/main` to `holmes` -> user
  sets/confirms Railway env vars -> user reports back the deploy result.
- I cannot register OAuth apps on Slack's or Google's developer consoles —
  those require the user's own accounts/org verification. This blocks all
  of Phase 3 until the user does that setup.

## Phases

### Phase 1 — SQR Agent (no external accounts needed)
- Swap the `.xlsx` download to a plain Blob/`<a download>` link.
- Stand up the Express backend skeleton + `/api/sample` route.
- Point SQR Agent's `classifyPending()` at `/api/sample` when
  `window.claude` isn't present.
- Needs from the user: an Anthropic API key, set as `ANTHROPIC_API_KEY` in
  Railway's environment variables (never committed).

### Phase 2 — Pacing Desk
- Add a database (Railway Postgres addon recommended over SQLite-on-volume,
  for durability and because the daily-refresh pipeline runs from a
  different machine than the Railway service).
- Build the four REST routes above; migrate the front-end's `db` calls.
- Extend the existing daily-refresh pipeline to also POST to this API.
- Needs from the user: provisioning the Railway Postgres addon (or
  confirming SQLite + a persistent volume instead) and the resulting
  connection string as a Railway env var.

### Phase 3 — Client Feedback Agent
- Register a Slack app (search scope) and a Google OAuth app (Drive +
  Gmail read scopes) — **user action, cannot be done by Claude**.
- Backend OAuth start/callback routes, encrypted token storage.
- Search + summarize routes.
- This phase is materially slower than the other two (Google's OAuth
  consent screen can require review) and should not block shipping
  Phases 1-2.

## Explicitly deferred
- No attempt to make the Railway version byte-identical to the Artifact
  version's runtime — they'll share HTML/CSS but branch in JS based on
  whether `window.claude` exists.
- No multi-tenant auth on the Railway site itself in this pass — anyone
  with the URL can use it, same trust level as the public repo today.
