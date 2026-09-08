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

Once call-recording access lands, next step is a real plan.md for the agent
itself — needs deciding: one combined chat surface or does each source get
its own first pass; how "give me last meeting's summary" resolves to a
specific call/thread when the user doesn't name one; live query each time
vs. some pre-indexed/cached layer for speed.

## Open questions for the user
- Where should this landing page + future agent code live — same
  `Budget-Optimization` repo, or its own repo (given it's a different,
  broader initiative than the pacing engine)?
- Client Feedback Agent: single combined tool, or does each input (Slack,
  email, calls) get its own separate first pass?
