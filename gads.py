"""Adapter for the Google Ads UI campaign export ("Campaign Spends.xlsx").

This is a strictly better input than the Supermetrics `Data` tab, because it
carries three things Supermetrics does not:

  * `Budget`        - the campaign's REAL daily budget. No more inferring it
                      from run-rate, so move amounts are exact.
  * `Campaign status` - Enabled/Paused, so a dark campaign is identifiable.
  * `Search impr. share` + top/abs-top IS - headroom signal.

Expected columns:
  Day | Campaign status | Campaign | Budget | Budget name | Budget type |
  Account | Campaign type | Bid strategy type | Impr. | Search abs. top IS |
  Search top IS | Search impr. share | Cost | Conversions | Clicks | CTR | ...
"""
from __future__ import annotations

import re
from pathlib import Path

import openpyxl
import pandas as pd

from loaders import norm

# Google Ads account name -> Budget Tracker account name, where they differ.
ACCOUNT_ALIASES = {
    "daniel i. shapiro, m.d., p.c.": "Shapiro Plastic Surgery",
}

# Google Ads accounts that hold MANY budgeted locations, where the Budget
# Tracker has a row per location rather than per Google Ads account.
# The location is read out of the campaign NAME by matching it against the
# budget account names — never by splitting on a delimiter, because naming is
# inconsistent (P2_Generic_PortersNeck vs P2_Pmax_Porters_Neck).
SPLIT_ACCOUNTS = {"riccobene"}

# Google Ads accounts that hold many locations under ONE budget line.
# The account keeps its single budget; these rules only fence moves so that
# one location never donates to another.
#   callable: campaign name -> group label
LOCATION_RULES = {
    # <Location>_<Type>, e.g. Arlington_Brand, Attleboro_Display_...
    "gentle dental": lambda c: c.split("_")[0] if "_" in c else c,
    "great hill dental": lambda c: c.split("_")[0] if "_" in c else c,
}

MIN_LOC_TOKEN = 5   # shortest prefix we will trust when matching a location


def match_location(campaign: str, keys: list[str]) -> str | None:
    """Find which budgeted location a campaign belongs to, by name.

    Works on the normalized strings, so underscores, spaces, hyphens and case
    all stop mattering:
        P2_Pmax_Porters_Neck  -> p2pmaxportersneck  contains  portersneck
        P2_Generic_Myrtle     -> p2genericmyrtle    starts a prefix of
                                                    myrtlebeachdenovo
    Longest match wins, so 'Cary' never steals a 'CaryWest' campaign.
    """
    c = norm(campaign)
    best, best_len = None, 0
    for k in keys:
        if len(k) >= MIN_LOC_TOKEN and k in c and len(k) > best_len:
            best, best_len = k, len(k)
    if best:
        return best
    # Fall back: the campaign carries a prefix of a longer budget name.
    for k in keys:
        for n in range(len(k), MIN_LOC_TOKEN - 1, -1):
            if k[:n] in c and n > best_len:
                best, best_len = k, n
                break
    return best


def _pct(v) -> float | None:
    """'< 10%' -> 0.05,  '> 90%' -> 0.95,  ' --' -> None,  0.3 -> 0.3"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s in ("", "--", "- -", "—") or s.startswith("--") or s == " --":
        return None
    if s.startswith("<"):
        return 0.05
    if s.startswith(">"):
        return 0.95
    s = s.rstrip("%")
    try:
        f = float(s)
        return f / 100 if f > 1 else f
    except ValueError:
        return None


def load_export(path: str | Path) -> pd.DataFrame:
    """-> date | account_raw | campaign | campaign_type | status | bid_strategy
          | budget | cost | conversions | impressions | clicks | search_is
    """
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    hdr = [str(c).strip() if c is not None else "" for c in rows[0]]
    df = pd.DataFrame(rows[1:], columns=hdr)
    df = df[df["Day"].notna()].copy()

    num = lambda c: pd.to_numeric(df[c], errors="coerce").fillna(0.0)
    out = pd.DataFrame({
        "date": pd.to_datetime(df["Day"], errors="coerce"),
        "account_raw": df["Account"].astype(str).str.strip(),
        "campaign": df["Campaign"].astype(str).str.strip(),
        "campaign_type": df["Campaign type"].astype(str).str.strip(),
        "status": df["Campaign status"].astype(str).str.strip(),
        "bid_strategy": df["Bid strategy type"].astype(str).str.strip(),
        "budget": num("Budget"),
        # Shared/portfolio budgets: many campaigns draw on ONE pool. ' --'
        # means the campaign has its own budget.
        "budget_name": (df["Budget name"].astype(str).str.strip()
                        .replace({"--": "", "- -": "", "nan": "", "None": ""})
                        if "Budget name" in df else ""),
        "cost": num("Cost"),
        "conversions": num("Conversions"),
        "impressions": num("Impr."),
        "clicks": num("Clicks"),
        "conv_value": 0.0,
        "search_is": df["Search impr. share"].map(_pct) if "Search impr. share" in df else None,
    })
    return out[out["date"].notna()].reset_index(drop=True)


def resolve(df: pd.DataFrame, budgets: pd.DataFrame,
            channel: str = "Google") -> tuple[pd.DataFrame, list[str]]:
    """Attach `client`, `account` (Budget Tracker naming) and `location`.

    Rows that cannot be tied to a budgeted account are dropped and reported.
    """
    b = budgets.copy()
    if channel:
        # The export is one channel only; a Meta/Bing budget row must not
        # be matched against Google spend.
        b = b[b["channel"].str.contains(channel, case=False, na=False)]
    b = b[b["allocated_budget"] > 0]

    by_acct = {k: (c, a) for k, c, a in zip(b["key"], b["client"], b["account"])}
    warns: list[str] = []

    df = df.copy()
    df["_alias"] = df["account_raw"].str.lower().map(ACCOUNT_ALIASES).fillna(df["account_raw"])
    df["_k"] = df["_alias"].map(norm)

    # --- level 1: the Google Ads account IS a Budget Tracker account -------
    df["client"] = df["_k"].map(lambda k: by_acct.get(k, (None, None))[0])
    df["account"] = df["_k"].map(lambda k: by_acct.get(k, (None, None))[1])

    # --- level 2: the account holds many budgeted locations ---------------
    # e.g. Google Ads "Riccobene" -> Budget Tracker "Benson", "Hampstead", ...
    miss = df["account"].isna()
    if miss.any():
        for raw, grp in df[miss].groupby("account_raw"):
            if raw.lower() not in SPLIT_ACCOUNTS:
                continue
            # Only consider budget rows that could plausibly belong to this
            # Google Ads account — otherwise a short location name from
            # another client could win the match.
            same = {k: v for k, v in by_acct.items()
                    if any(norm(c) == norm(raw) for c in [v[0]])}
            keys = sorted(same or by_acct, key=len, reverse=True)
            hit = grp["campaign"].map(lambda c: match_location(c, keys))
            mapped = hit.map(lambda k: (same or by_acct).get(k, (None, None)))
            df.loc[grp.index, "client"] = [m[0] for m in mapped]
            df.loc[grp.index, "account"] = [m[1] for m in mapped]

    # --- location group (moves never cross one) ---------------------------
    def group(row):
        rule = LOCATION_RULES.get(str(row["account_raw"]).lower())
        return rule(row["campaign"]) if rule else row["account"]
    df["location"] = df.apply(group, axis=1)

    # --- report what fell out ---------------------------------------------
    lost = df[df["account"].isna()]
    if not lost.empty:
        for raw, g in lost.groupby("account_raw"):
            spend = g["cost"].sum()
            if spend <= 0:
                continue
            rule = LOCATION_RULES.get(str(raw).lower())
            if rule is not None:
                locs = sorted(set(g["campaign"].map(rule)))
                warns.append(f"'{raw}' — {len(locs)} location(s) spent ${spend:,.0f} "
                             f"MTD with no budget row: {', '.join(locs)}")
            else:
                warns.append(f"'{raw}' spent ${spend:,.0f} MTD but has no "
                             f"{channel} budget row in the Budget Tracker.")
    df = df[df["account"].notna()].copy()

    # budgeted accounts with no spend at all
    import config
    paused = {norm(x) for x in config.PAUSED_ACCOUNTS}
    seen = set(df["_k"]) | {norm(a) for a in df["account"]}
    for _, r in b.iterrows():
        if r["key"] not in seen and r["key"] not in paused:
            warns.append(f"{r['client']} / '{r['account']}' has a "
                         f"${r['allocated_budget']:,.0f} budget but no campaign data.")

    return df.drop(columns=["_alias", "_k"]).reset_index(drop=True), warns
