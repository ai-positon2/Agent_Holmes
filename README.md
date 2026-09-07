# Budget Optimization Agent

Daily budget-pacing tool for the Position2 PPC team: reads a Google Ads export and the
"Budget Tracker" sheet, and tells each account manager where to move budget today so
every account lands the month at 100% of its allocation. Portfolio: 11 clients, 46
accounts, 728 campaigns, ~$322k/month.

## Status (2026-09-07)

**Recovered.** The engine was built in a Cowork session whose sandbox filesystem isn't
this machine — nothing under `C:\`, `D:\`, the mounted Google Drive, or Recycle Bin ever
had it, which is why an earlier pass here concluded it was lost. It wasn't: the Cowork
chat had already zipped the whole thing as `budget-agent-handoff.zip`, delivered to this
machine's Downloads folder days ago, sitting right next to `HANDOFF.md`. This repo is
that zip's contents, git-tracked from now on so this can't happen again.

- [`HANDOFF.md`](HANDOFF.md) — the full design spec, domain rules, and history. Read
  this first.
- [`ENGINE_NOTES.md`](ENGINE_NOTES.md) — the engine's own README from the Cowork build;
  slightly older than `HANDOFF.md` in a few numbers (e.g. it says 7 validate.py checks,
  HANDOFF.md says 12 — HANDOFF.md is the newer, authoritative account) but useful detail
  on ranking weights, guardrails, and adding a new client.
- `categories.py`, `config.py`, `engine.py`, `export_dashboard.py`, `gads.py`,
  `loaders.py`, `pacing.py`, `run.py`, `slack_fmt.py`, `validate.py` — the engine itself,
  recovered as-is.
- `raw/budget_tracker.xlsx`, `out/dashboard.json` — the Budget Tracker export and the
  engine's own dashboard payload from the last real run (Sept 7 2026), kept as fixtures.
  The Google Ads export (`Campaign Spends.xlsx`) is a fresh daily download, not
  committed here — see `run.py`'s docstring for the exact command.
- [`dashboard/`](dashboard/) — the rebuilt front end (`dashboard_template.html`). The
  engine's own copy of the pre-rebuild page was in the zip too but isn't kept here since
  it's superseded; this is the version live at the published Claude Artifact, reading
  its data from the artifact's own database instead of a `__DATA__` string-substitution
  build step.

## Running it

```bash
python3 run.py --export "Campaign Spends.xlsx" --as-of 2026-09-07   # per-client Slack markdown + JSON -> out/
python3 validate.py 2026-09-07                                       # 12 self-checks; must print 0 issues
python3 export_dashboard.py 2026-09-07                                # one JSON payload -> out/dashboard.json
```

Deps: `pandas`, `numpy`, `openpyxl`. Ground truth regression test: Riccobene reconciles
exactly to its own September DPR — $3,288.96 across 10 locations, all 40 campaigns.

## Open items (from HANDOFF.md — still unresolved)

1. Slack posting — the connector's channel membership was fixed this session (Claude is
   now in `#adcopyqc`); the formatter itself is untested against that live access yet.
2. Whether "Allocated Budget" is monthly or daily for 8 ecommerce accounts — pacing is
   suppressed for them pending an answer.
3. ~$98,600 MTD spend with no Budget Tracker row (Workato Demand Generation alone is
   $84,624).
4. Five accounts can't reach budget at current daily caps — $8,973 at risk.
5. Data window is Sept 1–6 only; a longer window would sharpen the absorption signal.
