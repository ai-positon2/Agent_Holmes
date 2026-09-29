# Phase 3: Client Feedback Agent, standalone on Railway

## Why this is different from Phases 1-2

Inside Claude, this page's whole engine is `window.claude.use("sample")` running its
own multi-turn tool-use loop in the browser: it hands Claude 6 tool definitions, and
when Claude wants to call one, the *browser* executes it by calling `mcp.server(name)`,
which proxies to the user's already-authorized Claude connectors (Slack, Google Drive,
Gmail). None of that exists outside Claude -- there is no `mcp`, no per-user connector
auth, and no client-side tool loop talking directly to Anthropic.

So Phase 3 isn't a capability shim like Phases 1-2. It's:
- Our own Slack OAuth app + our own Google OAuth client (Divith authorizes once, we
  store the tokens) -- prerequisite, blocks everything else.
- A real Anthropic tool-use loop running server-side (multi-turn: call Claude with
  `tools`, execute any `tool_use` block ourselves, send `tool_result` back, repeat).
- Server-side reimplementations of all 6 tools against the real Slack/Gmail/Drive
  REST APIs (not MCP).
- A token store in Postgres (single-tenant -- one Slack grant, one Google grant).
- A rewritten frontend boot/send flow that checks `/api/feedback/status` instead of
  `mcp.listTools()`, and posts to `/api/feedback/chat` instead of calling `sample()`.

## Prerequisites (user action, blocking)

**Slack app** (api.slack.com/apps -> Create New App -> From scratch) -- DONE:
- OAuth & Permissions -> redirect URL: `https://agentholmes-production.up.railway.app/auth/slack/callback`
- **User Token Scopes** (not Bot Token Scopes -- search must run as a real user):
  `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`,
  `channels:read`, `groups:read`
- Set `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` as Railway env vars on Agent_Holmes
  (never commit them) -- same pattern as `ANTHROPIC_API_KEY` and `SEED_SECRET`.

**Google (Drive + Gmail) -- CHANGED, no OAuth app needed.** Getting IT to stand up
a Google Cloud project (OAuth consent screen, verification, etc.) was enough
friction that we dropped it. Instead: a scheduled task in this Claude Code
project (which already has Drive and Gmail connectors authorized for this
session) pulls a bounded slice of data on a schedule and pushes it to Railway's
Postgres via a new `/api/feedback/seed` route, reusing the existing `SEED_SECRET`.
The tools that used to hit Drive/Gmail live now read that mirror instead. Trade-off:
Google-backed answers are "as of the last sync," not truly live -- fine for meeting
notes / budget / recent email, which don't change minute to minute.

## Architecture

**Postgres tables** (`server/db.js`):
- `oauth_tokens(provider TEXT PRIMARY KEY, access_token, refresh_token, expires_at,
  meta JSONB)` -- one row, `"slack"` (Google no longer stores a token here).
- `feedback_meeting_docs(id TEXT PRIMARY KEY, name, modified_time, content)`,
  `feedback_budget_tracker(id INTEGER PRIMARY KEY DEFAULT 1, content)`,
  `feedback_emails(thread_id TEXT PRIMARY KEY, subject, sender, date, snippet, body)`,
  `feedback_sync_meta(key TEXT PRIMARY KEY, value JSONB)` -- the Google mirror,
  replaced wholesale on every sync (`seedFeedback`).

**Routes** (`server/feedback.js`, mounted from `server/index.js`):
- `GET /auth/slack/start` / `GET /auth/slack/callback` -- unchanged, real Slack OAuth
- `GET /api/feedback/status` -> `{slack: "connected"|"unknown", google: {at, meetingDocs, emails} | null}`
- `POST /api/feedback/seed` -> `{meetingDocs, budgetTracker, emails}` in, guarded by
  `x-seed-secret` (reuses Pacing Desk's `SEED_SECRET`, not a new one) -- the scheduled
  task's push target
- `POST /api/feedback/chat` -> `{message, history}` in, runs the tool-use loop
  in-process, returns `{text, toolsUsed}`

**The tool-use loop**: call `POST https://api.anthropic.com/v1/messages` with the 6
tools in Anthropic's `{name, description, input_schema}` shape and the running
message list; if the response's `stop_reason` is `tool_use`, execute each tool block
server-side, append a `tool_result` user turn per block, and call again; stop when
`stop_reason` is `end_turn`, capped at 6 rounds to avoid a runaway loop.

**The 6 tools**:
- `search_slack` -> Slack `search.messages` (needs the **user** token, not bot)
- `read_slack_channel` -> Slack `conversations.history`
- `get_meeting_transcript` -> reads `feedback_meeting_docs` (mirrored), same
  token-match scoring logic as the original MCP-backed version
- `get_budget_snapshot` -> reads `feedback_budget_tracker` (mirrored)
- `search_email` -> `ILIKE` over `feedback_emails` (mirrored; no more Gmail search
  operators, plain substring match against subject/sender/snippet/body)
- `read_email` -> reads one `feedback_emails` row by thread_id

**The sync job** (a scheduled task, not part of the Railway deploy): using this
Claude Code project's already-authorized Drive/Gmail connectors, pull the last few
meeting-notes docs (full text), the Budget Tracker (full text), and a bounded
recent slice of Gmail threads (truncated per-thread), then `POST` all of it to
`/api/feedback/seed`. Same shape as `refresh-pacing-desk`'s scheduled task, just a
different payload and endpoint.

**Frontend** (`landing/client_feedback_agent.html`, dual-mode like Phases 1-2): keep
the Claude-sandbox path exactly as-is; outside it, boot calls `/api/feedback/status`,
renders a Slack "connect" pill (links to `/auth/slack/start` when not yet
authorized) and a Google "synced <date>" / "not yet synced" pill (informational
only, nothing to click), and posts to `/api/feedback/chat` for `send()` instead of
calling `sample()`. No streaming server-side (matches Phase 1's `/api/sample` -- a
single "Thinking..." state until the final reply).

## Build order

1. ~~`oauth_tokens` table + token get/set helpers~~ -- done (Slack only now).
2. ~~Slack OAuth start/callback routes~~ -- done, user has Client ID/Secret.
3. ~~Google mirror tables + `seedFeedback`/status/read helpers in `server/db.js`~~ -- done.
4. ~~The 6 tools, Slack live + Google mirror-backed~~ -- done.
5. ~~The tool-use loop + `/api/feedback/chat` + `/api/feedback/status` + `/api/feedback/seed`~~ -- done.
6. ~~Frontend dual-mode rewrite~~ -- done.
7. **Next**: set `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` on Railway, deploy, verify
   the Slack OAuth round-trip live.
8. **Next**: build the `refresh-client-feedback` scheduled task (mirrors
   `refresh-pacing-desk`'s pattern) and verify one real sync + a chat question that
   needs each of Slack, meeting transcripts, budget snapshot, and email.

## Constraints carried over

- Public repo: `SLACK_CLIENT_SECRET` / tokens never committed, Railway env vars only.
- I don't have Railway dashboard access -- every env var add/redeploy is relayed to
  the user, verified afterward via the live browser tool.
- `git push holmes main` still has to be run by the user; I only push `origin`.
- No Google Cloud project needed at all anymore -- nothing to hand IT.
