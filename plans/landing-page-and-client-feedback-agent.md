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
Reads Slack (client-internal groups), email, and call recordings (internal +
client calls) to produce feedback intelligence. **Not being built yet.**

Access status (as of 2026-09-08):
- **Slack** — user says Claude has been invited to all internal groups.
  Unverified in general, and the one channel actually checked so far
  (`#adcopyqc`, for the *other* agent) turned out not to be about a "Claude"
  bot invite at all — the connector authenticates as a real person, Krishna
  Ladha, so "internal groups" access really means Krishna's own channel
  memberships. Don't assume this is sorted for any specific client channel
  without checking membership the same way (see project memory).
- **Email** — divith.k@position2.com is added to every client's alias
  group, so once an email connector (Gmail/Outlook) is connected for that
  address, it should already cover all clients — no per-client mailbox setup
  expected to be needed. Connector itself still not connected as of this
  writing.
- **Call recordings** — user is gathering the remaining access info
  (which platform, credentials). Apollo.io is already connected in this
  environment and has conversation-intelligence tools
  (get_transcript/get_recording_links/get_insights) — worth checking whether
  Position2's calls already run through Apollo before adding a new connector.

Once access exists, next step would be a real plan.md for the agent itself
(data model, what "feedback" means as output, cadence) before writing code.

## Open questions for the user
- Where should this landing page + future agent code live — same
  `Budget-Optimization` repo, or its own repo (given it's a different,
  broader initiative than the pacing engine)?
- Client Feedback Agent: single combined tool, or does each input (Slack,
  email, calls) get its own separate first pass?
