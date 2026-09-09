# Plan: SQR Agent — "Search Query Analysis" card

**Asked:** 2026-09-09/10. New Agent Desk card, "Search Query Analysis" — a
dropdown of accounts, each account running its own SQR (search query report)
review logic, since different AMs classify differently per client. Riccobene
and OIA already exist as Claude Code skills (`sqr-analysis-riccobene`,
`sqr-analysis-oia`) — use those now; other accounts get added over time.

## What the two existing skills actually are (read both in full first)

Both are large, mature rule documents (~9-10KB each), same shape:
- **Input:** 3 CSVs per run — `Search_terms_report.csv` (raw SQR data),
  `Search_keyword_report.csv` (existing bidded keywords, for dedup),
  `Negative_keyword_details_report.csv` (existing negatives, for dedup).
  Standard Google Ads UI exports.
- **Pre-processing:** strip Google's `Total:` subtotal rows (inflate spend
  up to 6x if left in) before anything else.
- **Classification:** a numbered priority waterfall, stop at first match
  (Riccobene: 23 checks; OIA: 16 checks) — brand terms, competitor
  list/individual-practitioner patterns, address/phone patterns, several
  "disqualifier" categories (jobs, education, reviews, price-seeking,
  informational, veterinary, DIY, dental-products/free-seeking,
  non-profit), insurance/coverage rules, out-of-area city list, a
  campaign→territory map for Location Mismatch detection, then a core
  service-signal check, then a final default.
- **Negatives/new-keywords logic:** dedup against existing lists, PMax vs.
  Search split, match-type rules, impact-score ranking, capped at ~30 each
  for the priority sheet with a full reference list alongside.
- **Output:** 7 sheets (SQR Analysis / Summary / Negatives to Add /
  New Keywords to Add / Client Review Required / All Negatives Reference /
  All Keywords Reference), color-coded by classification.
- Both carry an account-specific "known-issue log" of past real mistakes
  (e.g. Riccobene: Rock Hill vs. Fort Mill is NOT a location mismatch;
  OIA: bare "AMI" only means the Kokomo facility with IN/Kokomo context).

**Important honesty note:** the skill documents fully enumerate some
trigger categories (brand terms, competitor lists, insurance carriers,
out-of-area cities, campaign-territory maps, core service-signal keyword
list) but only *name* several others (jobs/recruitment, education,
reviews, DIY, generic price-seeking, informational, veterinary,
dental-products, non-profit) without a verbatim keyword list — those
defer to companion docx files the skill references but that aren't
embedded in it, and I don't have them. Faking a keyword list for those
would be less accurate than just asking the model, so the build below
splits work accordingly rather than hand-guessing word lists.

## Architecture decision

A **published Artifact**, its own card on Agent Desk, not a live chat —
this is a classify-and-report tool, closer in shape to Pacing Desk than to
Client Feedback Agent.

- **Account dropdown** picks a *ruleset*: `riccobene`, `oia`, or
  `generic` (a plain, no-account-specific-knowledge classifier, used as
  the fallback for every account that doesn't have a dedicated ruleset
  yet — "the remaining we can keep adding on the go").
- **CSV upload, client-side** (`<input type=file>` + a small hand-rolled
  CSV parser — no server, no connector needed for this part; an AM
  exports straight from Google Ads and drops the files in).
- **Hybrid classification, per row:**
  1. A deterministic JS port of every *fully-specified* rule from the
     skill — brand terms, competitor/practitioner match, address/phone
     regex, insurance carriers, out-of-area cities, the campaign→territory
     map, the core-service-signal keyword list, and the account's known
     special cases (Rock Hill/Fort Mill, bare "AMI", `raleigh radiology`,
     JV same-name logic, etc.). Runs instantly, for free, on every row,
     faithful to the skill's exact priority order.
  2. Rows that fall through unresolved (the underspecified disqualifier
     categories) get batched to one `sample.json()` call per account,
     describing those remaining categories by name and asking for a
     classification — this is where real model judgment earns its keep,
     rather than a guessed keyword list pretending to be the skill's own.
  3. Negative/new-keyword dedup, impact scoring, tiering, and the ~30 cap
     all run in JS against the combined result (deterministic, exact).
- **Output:** on-page color-coded tables (Summary, Priority Negatives,
  Priority Keywords, Client Review, collapsible full reference tables),
  plus a downloadable multi-sheet `.xlsx` via the `downloads` capability
  (SheetJS from cdnjs) matching the skill's 7-sheet shape. Known trade-off:
  free SheetJS can't set cell background colors, so the downloaded file
  won't carry the color-coding the skill's own checklist calls for — the
  on-screen table does, and that's disclosed rather than silently dropped.
- **`generic` ruleset** (unmapped accounts): every row goes to
  `sample.json()` with a plain SQR-classification prompt (Relevant /
  Competitor / Not Relevant / Client Review, no account-specific brand or
  competitor knowledge) — clearly labeled as the fallback it is.

## Explicitly deferred / not attempted this pass
- No attempt to reproduce cell-fill colors in the downloaded workbook.
- No attempt to guess the missing trigger word lists verbatim — routed to
  the model instead, as above.
- Only Riccobene and OIA get a dedicated ruleset. Adding another real
  account means writing/porting its ruleset the same way these two were —
  not automatic.
