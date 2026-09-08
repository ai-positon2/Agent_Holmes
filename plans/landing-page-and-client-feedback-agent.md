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
client calls) to produce feedback intelligence. **Not being built yet** —
this phase is just an access/connector requirements list, delivered in chat,
so the user can start requesting the right access before build work starts.

Once access exists, next step would be a real plan.md for the agent itself
(data model, what "feedback" means as output, cadence) before writing code.

## Open questions for the user
- Where should this landing page + future agent code live — same
  `Budget-Optimization` repo, or its own repo (given it's a different,
  broader initiative than the pacing engine)?
- Client Feedback Agent: single combined tool, or does each input (Slack,
  email, calls) get its own separate first pass?
