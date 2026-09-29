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

**Slack app** (api.slack.com/apps -> Create New App -> From scratch):
- OAuth & Permissions -> redirect URL: `https://agentholmes-production.up.railway.app/auth/slack/callback`
- **User Token Scopes** (not Bot Token Scopes -- search must run as a real user):
  `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`,
  `channels:read`, `groups:read`
- Install to workspace, or just have Client ID + Client Secret ready -- the OAuth
  flow itself does the per-user install.

**Google OAuth client** (console.cloud.google.com -> APIs & Services -> Credentials):
- Create OAuth client ID, type "Web application"
- Authorized redirect URI: `https://agentholmes-production.up.railway.app/auth/google/callback`
- Enable the Gmail API and Google Drive API on the project
- Scopes requested at consent: `https://www.googleapis.com/auth/gmail.readonly`,
  `https://www.googleapis.com/auth/drive.readonly`
- One OAuth client covers both Drive and Gmail (one consent screen, two scopes) --
  the original page's 3 source pills become 2 real connections (Slack, Google).

Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
as Railway env vars on Agent_Holmes (never commit them) -- same pattern as
`ANTHROPIC_API_KEY` and `SEED_SECRET`.

## Architecture

**New Postgres table** (`server/db.js`): `oauth_tokens(provider TEXT PRIMARY KEY,
access_token TEXT, refresh_token TEXT, expires_at TIMESTAMPTZ, meta JSONB)` -- rows
`"slack"` and `"google"`.

**New routes** (`server/feedback.js`, mounted from `server/index.js`):
- `GET /auth/slack/start` -> redirect to Slack's authorize URL
- `GET /auth/slack/callback` -> exchange code, store token, redirect to
  `/client_feedback_agent.html?connected=slack`
- `GET /auth/google/start` / `GET /auth/google/callback` -> same shape, Google's
  token endpoint additionally returns a refresh_token (only on first consent with
  `access_type=offline&prompt=consent`)
- `GET /api/feedback/status` -> `{slack: "connected"|"unknown", google: "connected"|"unknown"}`
- `POST /api/feedback/chat` -> `{message, history}` in, runs the tool-use loop
  in-process (refreshing Google's access token via its refresh_token when expired;
  Slack user tokens don't expire), returns `{text, toolsUsed}`

**The tool-use loop**: call `POST https://api.anthropic.com/v1/messages` with the 6
tools in Anthropic's `{name, description, input_schema}` shape and the running
message list; if the response's `stop_reason` is `tool_use`, execute each tool block
server-side against the real API, append a `tool_result` user turn per block, and
call again; stop when `stop_reason` is `end_turn`, capped at ~6 rounds to avoid a
runaway loop.

**The 6 tools**, reimplemented against real REST endpoints instead of MCP:
- `search_slack` -> `search.messages` (needs the **user** token, not bot)
- `read_slack_channel` -> `conversations.history`
- `get_meeting_transcript` -> Drive `files.list` (parent = the Meeting Notes folder)
  + `files.export` (mimeType `text/plain`) on the top matches, same token-match
  scoring logic as the original
- `get_budget_snapshot` -> Drive `files.export` on the Budget Tracker file ID
- `search_email` -> Gmail `users.threads.list?q=...`
- `read_email` -> Gmail `users.threads.get`

**Frontend** (`landing/client_feedback_agent.html`, dual-mode like Phases 1-2): keep
the Claude-sandbox path exactly as-is; add an else-branch that calls
`/api/feedback/status` on boot to paint the source pills, shows "Connect Slack" /
"Connect Google" buttons (linking to the `/auth/*/start` routes) when not yet
authorized, and posts to `/api/feedback/chat` for `send()` instead of calling
`sample()`. No streaming server-side for v1 (matches Phase 1's `/api/sample` -- a
single "Thinking..." state until the final reply, not live per-tool status text).

## Build order

1. `oauth_tokens` table + token get/set helpers in `server/db.js`.
2. Slack OAuth start/callback routes; verify by hand once `SLACK_CLIENT_ID/SECRET`
   are set.
3. Google OAuth start/callback routes (with refresh-token handling); verify by hand.
4. The 6 tools as plain server-side functions against the real APIs.
5. The tool-use loop + `/api/feedback/chat` + `/api/feedback/status`.
6. Frontend dual-mode rewrite.
7. End-to-end live test: ask a real question that needs Slack, one that needs Drive,
   one that needs Gmail.

## Constraints carried over

- Public repo: `SLACK_CLIENT_SECRET` / `GOOGLE_CLIENT_SECRET` / tokens never
  committed, Railway env vars only.
- I don't have Railway dashboard access -- every env var add/redeploy is relayed to
  the user, verified afterward via the live browser tool.
- `git push holmes main` still has to be run by the user; I only push `origin`.
