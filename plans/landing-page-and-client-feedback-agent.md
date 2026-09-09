# Plan: Tools landing page + Client Feedback Agent scoping

**Asked:** 2026-09-08. Build a landing page with two cards — one linking to the
existing Pacing Desk dashboard, one for an upcoming "Client Feedback Agent" —
and separately, say what access the Client Feedback Agent would need.

## Phase 1 — Landing page (done 2026-09-08)
- [x] Single-page artifact, two cards: "Pacing Desk" (live, links to the
      published dashboard) and "Client Feedback Agent" (coming soon /
      in scoping, no link yet).
- [x] Same design tokens as the Pacing Desk for visual consistency.
- [x] Publish as its own Artifact (not merged into the dashboard artifact).
      → https://claude.ai/code/artifact/4b6f918a-fc9b-468a-8e28-eff3f6204bab
      ("Agent Desk"), source at `landing/agent_desk.html`.

## Phase 2 — Client Feedback Agent (not started; scoping only right now)

**What it is, per 2026-09-09 clarification:** not a dashboard — a **chat
interface**. Clicking its card on the landing page opens a conversational UI
where an AM types natural-language questions like "give me a summary of the
previous meeting" or "what's the latest budget for [client]" and gets an
answer pulled live from Slack, email, and call recordings. This is a
materially different build from Pacing Desk (a static/db-backed dashboard) —
it needs a live query-answering loop, most naturally the `sample` capability
(Claude answering inside the artifact) rather than a fixed data model.

Access status (as of 2026-09-09):
- **Slack** — CONFIRMED broad access: `slack_list_user_channels` shows 65
  channels including most client-internal ones (`#oia-internal`,
  `#eventgroove-p2-internal`, `#inspire-aesthetics-px`, `#riccobene`,
  `#riccobene-ppc`, `#mchale-landscape-internal`, `#tealium-pa-internal`,
  `#bb-pa-internal`, `#internal-soteri-skin`, `#gentle-dental-px`, etc.).
  Caveat that still applies: this connector authenticates as a real person
  (currently works after a re-auth), not a bot — if it breaks again, check
  identity/channel membership the way described in project memory, don't
  assume an "invite Claude" step is what's needed.
- **Email** — CONFIRMED working (connector id `fa4a0642-...`, Gmail-shaped
  tools: search_threads, get_thread, send_message, etc.). Verified with a
  real read-only search against divith.k@position2.com's inbox. Since that
  address is on every client's alias group, this one connector should cover
  all clients without per-client setup.
- **Call recordings** — still pending; user is gathering the remaining
  access info (which platform, credentials). Apollo.io is already connected
  in this environment and has conversation-intelligence tools
  (get_transcript/get_recording_links/get_insights) — worth checking whether
  Position2's calls already run through Apollo before adding a new connector.

**Separately:** user is getting a dedicated Slack app/bot approved
specifically for *posting* (Pacing Desk's alerts), decoupled from whichever
identity this connector reads as. Not wired into anything yet.

- **Call recordings/meeting transcripts** — CONFIRMED 2026-09-09. User shared
  a Drive folder ("Meeting Notes",
  `1hc1fPOHKsUNGbqBClcb4G7qwa5T38KYf`) fed daily by a Zoom-notetaker
  automation. Format: one Google Doc per day containing every meeting from
  that day concatenated, each section shaped
  `Meeting: <title>\nDate: <ISO>\nDuration:...\nTranscript:\n<text>`. Verified
  27 real meetings in one day's doc, including `Riccobene - Catch-Up` and
  `Position2 // Riccobene Weekly Check-In`. Known rough edge: the
  transcript-doc title carries an unrendered template expression
  (`{{new Date().toLocaleDateString(...)}}`) — cosmetic, doesn't block
  reading, but worth fixing at the automation source eventually.

All three access sources are now confirmed. Access is unblocked.

## Phase 2 build (started 2026-09-09)

**Architecture decision:** built as a second published Artifact (its own
chat-interface page, linked from Agent Desk's second card), using the
`mcp` + `sample` runtime capabilities together — not a custom backend:
- `mcp` capability lets the published page call the *viewer's own*
  claude.ai connectors (Slack, Google Drive, Gmail) directly, with the
  viewer's own credentials — so each AM who opens it sees only what they
  themselves have access to.
- `sample` capability (with `tools`) lets Claude read the AM's question,
  decide which of the page's data-fetching functions to call (one or more
  rounds), and write the final natural-language answer — a real agentic
  loop, not a fixed query.
- This resolves the "live query vs. cache" question from below: **live,
  every time** — no pre-indexed layer in v1. Each question triggers real
  Slack/Drive/Gmail calls through the viewer's connectors.
- Resolves "single surface vs. per-source": **single combined chat**, per
  the original spec — the model picks which source(s) to query per
  question.

**Tools exposed to the model (v1, all read-only):**
1. `search_slack` — `slack_search_public_and_private` across all
   channels/DMs the viewer can see.
2. `read_slack_channel` — `slack_read_channel` on a channel ID (typically
   one found via `search_slack` first).
3. `get_meeting_transcript` — searches the known Meeting Notes folder,
   reads the most recent daily doc(s), and extracts just the matching
   `Meeting:` section(s) by client/topic keyword (never returns a whole
   700K-character daily doc to the model).
4. `get_budget_snapshot` — reads the Budget Tracker sheet directly
   (`1X_HjD0...`) for "what's the latest budget for X" questions.
5. `search_email` — Gmail `search_threads`.
6. `read_email` — Gmail `get_thread` (plain-text body) on a thread ID.

Every tool's `execute()` truncates its result before returning it to the
model (per-tool and total-prompt size limits apply) — none of them hand
back a raw multi-hundred-KB document.

**Known v1 limitations, deliberately deferred:**
- Read-only — no drafting replies, no posting.
- No persistent chat history across visits (matches `sample`'s
  no-memory-between-calls design) — each open starts fresh.
- Tool names in the `mcp` manifest are the connector's *normalized* names
  observed in this session; the manifest wants the connector's *upstream*
  tool names, which can technically differ. Flagged as the one thing to
  verify on first real use — a `not_in_manifest` error is the tell.
- "Which meeting did they mean" is resolved by keyword match + letting the
  model reason over multiple matches' dates, not a hardcoded rule.

## Open questions for the user
- Where should this landing page + future agent code live — same
  `Budget-Optimization` repo, or its own repo (given it's a different,
  broader initiative than the pacing engine)? *(Still open — building in
  this repo for now since that's where Agent Desk already lives.)*
