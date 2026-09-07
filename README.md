# Budget Optimization Agent

Daily budget-pacing tool for the Position2 PPC team: reads a Google Ads export and the
"Budget Tracker" sheet, and tells each account manager where to move budget today so
every account lands the month at 100% of its allocation. Portfolio: 11 clients, 46
accounts, 728 campaigns, ~$322k/month.

## Status (2026-09-07)

**The original Python engine (`run.py`, `config.py`, `pacing.py`, `categories.py`,
`gads.py`, `loaders.py`, `engine.py`, `validate.py`, `slack_fmt.py`,
`export_dashboard.py`) is missing.** It was built in an ephemeral session (Cowork/Claude
Code) whose workspace was never a persistent, git-tracked folder — when that session
ended, its filesystem went with it. `HANDOFF.md` below is everything that survived: a
complete write-up of the domain rules, engine design, file list, and known bugs, written
by that session specifically so a fresh one could rebuild it. This repo exists so that
doesn't happen again — everything here is committed to git, not living only in a scratch
session.

- [`HANDOFF.md`](HANDOFF.md) — the full design spec and history, recovered from the
  original session's handoff note. Read this first.
- [`dashboard/`](dashboard/) — the rebuilt front end (`dashboard_template.html`), the
  one part of the project that *was* recovered, because it was already published as a
  live Claude Artifact and could be pulled back from there. It now reads its data from
  the artifact's own database (`dashboard/build_seed.js` seeds it, `dashboard/splice.js`
  bundles a fallback snapshot into the HTML) instead of a one-off template substitution.
  `dashboard/sample_snapshot.json` is a real Sept 7 2026 snapshot, kept as a fixture for
  local testing.

## What's needed next

The Python engine described in `HANDOFF.md` needs to be rebuilt from that spec (or
recovered from wherever the Cowork chat that built it originally lives — check there
before rewriting from scratch). Until then, the dashboard runs on a single bundled
snapshot and daily updates have to be produced by hand.
