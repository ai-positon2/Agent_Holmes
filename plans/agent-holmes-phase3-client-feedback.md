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

**Google (Drive + Gmail) -- back to live OAuth.** A synced-mirror alternative was
tried and reverted: the user needs answers that reflect Gmail/Drive *right now*,
which a periodic sync fundamentally can't give. Since Divith isn't the position2.com
Workspace admin, domain-wide delegation (no consent screen at all) isn't available
-- so this is the standard OAuth path:
- console.cloud.google.com -> APIs & Services -> Credentials -> Create OAuth client ID,
  type "Web application"
- Authorized redirect URI: `https://agentholmes-production.up.railway.app/auth/google/callback`
- Enable the Gmail API and Google Drive API on the project
- OAuth consent screen: **leave it in "Testing" status**, add Divith's own email as
  a test user. This is the important part -- it avoids Google's app verification
  process entirely (verification is only required to publish to "In production").
  The first time he authorizes, Google shows an "unverified app" warning -- that's
  expected for an internal single-user tool in Testing mode, not a sign of a
  misconfiguration. Click "Advanced" -> "Go to (app name) (unsafe)" to proceed.
- Scopes requested at consent: `https://www.googleapis.com/auth/gmail.readonly`,
  `https://www.googleapis.com/auth/drive.readonly`

Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` as Railway env vars on Agent_Holmes
(never commit them), same pattern as `SLACK_CLIENT_ID`/`SECRET`.

## Architecture

**Postgres table** (`server/db.js`): `oauth_tokens(provider TEXT PRIMARY KEY,
access_token, refresh_token, expires_at, meta JSONB)` -- rows `"slack"` and
`"google"`. (The mirror tables from the reverted approach --
`feedback_meeting_docs`/`feedback_budget_tracker`/`feedback_emails`/
`feedback_sync_meta` -- are gone; nothing ever wrote real data to them in
production, so there was nothing to migrate.)

**Routes** (`server/feedback.js`, mounted from `server/index.js`):
- `GET /auth/slack/start` / `GET /auth/slack/callback` -- real Slack OAuth
- `GET /auth/google/start` / `GET /auth/google/callback` -- real Google OAuth,
  covering both Drive and Gmail scopes in one consent (Google returns a
  refresh_token only on first consent with `access_type=offline&prompt=consent`,
  both already set)
- `GET /api/feedback/status` -> `{slack: "connected"|"unknown", google: "connected"|"unknown"}`
- `POST /api/feedback/chat` -> `{message, history}` in, runs the tool-use loop
  in-process (refreshing Google's access token via its refresh_token when
  expired; Slack user tokens don't expire), returns `{text, toolsUsed}`

**The tool-use loop**: call `POST https://api.anthropic.com/v1/messages` with the 6
tools in Anthropic's `{name, description, input_schema}` shape and the running
message list; if the response's `stop_reason` is `tool_use`, execute each tool block
server-side against the real API, append a `tool_result` user turn per block, and
call again; stop when `stop_reason` is `end_turn`, capped at 6 rounds to avoid a
runaway loop.

**The 6 tools**, live against the real REST APIs (not MCP, not a mirror):
- `search_slack` -> Slack `search.messages` (needs the **user** token, not bot)
- `read_slack_channel` -> Slack `conversations.history`
- `get_meeting_transcript` -> Drive `files.list` (parent = the Meeting Notes folder)
  + `files.export` (mimeType `text/plain`) on the top matches, same token-match
  scoring logic as the original MCP-backed version
- `get_budget_snapshot` -> Drive `files.export` on the Budget Tracker file ID
- `search_email` -> Gmail `users.messages.list?q=...` (real Gmail search syntax)
- `read_email` -> Gmail `users.threads.get`

**Frontend** (`landing/client_feedback_agent.html`, dual-mode like Phases 1-2): keep
the Claude-sandbox path exactly as-is; outside it, boot calls `/api/feedback/status`
and renders "Connect Slack" / "Connect Google" pills (linking to each `/auth/*/start`
route) when not yet authorized, and posts to `/api/feedback/chat` for `send()`
instead of calling `sample()`. No streaming server-side (matches Phase 1's
`/api/sample` -- a single "Thinking..." state until the final reply).

## Build order

1. ~~`oauth_tokens` table + token get/set helpers~~ -- done.
2. ~~Slack OAuth start/callback routes~~ -- done, user has Client ID/Secret, not yet
   set on Railway.
3. ~~Google OAuth start/callback routes (with refresh-token handling)~~ -- done,
   reverted back in after a mirror-based detour didn't meet the immediacy
   requirement.
4. ~~The 6 tools, live against Slack/Drive/Gmail~~ -- done.
5. ~~The tool-use loop + `/api/feedback/chat` + `/api/feedback/status`~~ -- done.
6. ~~Frontend dual-mode rewrite~~ -- done.
7. **Next**: register the Google OAuth client (Testing mode, self as test user --
   see Prerequisites above), set `SLACK_CLIENT_ID`/`SECRET` and
   `GOOGLE_CLIENT_ID`/`SECRET` on Railway, deploy, verify both OAuth round-trips
   live.
8. **Next**: end-to-end test -- ask a real question that needs Slack, one that
   needs Drive (meeting transcript or budget), one that needs Gmail.

## Zoom (live meeting transcripts)

Added on top of the base plan: `get_meeting_transcript` now checks Zoom's own cloud
recordings first, live, before falling back to the Drive meeting-notes folder.
Zoom uses **Server-to-Server OAuth** (an account-level credential, not a per-user
grant) -- no consent screen, nothing in `oauth_tokens`, just `ZOOM_ACCOUNT_ID` /
`ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` / `ZOOM_USER_ID` (whose recordings to search
-- S2S has no "me") as Railway env vars, fetched via `zoomAccessToken()`'s in-memory
cache. Blocked on whoever has Zoom account-owner/admin rights creating that app (not
Divith -- he doesn't have that access); see the Zoom API access request sent
directly as a file. If Zoom isn't configured, or the lookup errors, or nothing
matches, it falls through to the existing Drive-based logic silently -- the tool
always returns something, it just prefers the live source when available.

## Constraints carried over

- Public repo: `SLACK_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET` / tokens never
  committed, Railway env vars only.
- I don't have Railway dashboard access -- every env var add/redeploy is relayed to
  the user, verified afterward via the live browser tool.
- `git push holmes main` still has to be run by the user; I only push `origin`.
- Google's OAuth consent screen must stay in "Testing" status with Divith added as
  a test user -- moving to "In production" would trigger Google's verification
  process for these sensitive scopes, which is unnecessary friction for a
  single-user internal tool.
