"""Series flag `s` and MODIS-equivalent weight `w` for every pixel (sections 4.5, 4.11).

Carriers of the series, by local date:
  Aqua MODIS      2003-01-01 .. 2012-01-31   weight 1 / n_pix
  S-NPP VIIRS     2012-02-01 .. 2026-10-31   weight k / n_pix
  NOAA-20 VIIRS   2026-11-01 ..              weight k20 / n_pix
(S-NPP keeps carrying after 2026-10-31 when no NOAA-20 data is given.)

On a day when S-NPP delivered no data, or none by day, and NOAA-20 was flying
and working, NOAA-20 carries that whole day instead (`noaa20_fill_days`).

`wk` is the weight a pixel would carry, whether or not it is in the series;
`w` is `wk` for in-series pixels and 0 otherwise. Every number the app shows
is a sum of `w`. Validation compares sensors with `wk`.
"""
from __future__ import annotations

from datetime import date
from typing import Iterable

import duckdb

from . import calibrate, config

BLOCK_SQL = (
    "CAST(floor(cell01_lat / 500.0) AS INTEGER) || '|' || CAST(floor(cell01_lon / 500.0) AS INTEGER)"
)


def _viirs_weighted(table: duckdb.DuckDBPyRelation, model: dict, in_series: str) -> duckdb.DuckDBPyRelation:
    """VIIRS pixel rows with block, s, wk and w, using the calibrated k of each stratum."""
    strata = table.query("v", f"SELECT DISTINCT month, dn, {BLOCK_SQL} AS block, strength FROM v").df()
    strata["k"] = calibrate.predict(model, strata)
    k_rows = ", ".join(
        f"({int(r.month)}, '{r.dn}', '{r.block}', {int(r.strength)}, {float(r.k)!r})"
        for r in strata.itertuples()
    )
    return table.query("v", f"""
        WITH keyed AS (SELECT v.*, {BLOCK_SQL} AS block FROM v),
        k_table(month, dn, block, strength, k) AS (VALUES {k_rows})
        SELECT keyed.*,
            CAST({in_series} AS INTEGER) AS s,
            k_table.k / n_pix AS wk,
            CASE WHEN {in_series} THEN k_table.k / n_pix ELSE 0.0 END AS w
        FROM keyed JOIN k_table USING (month, dn, block, strength)
    """)


def noaa20_fill_days(outages: Iterable[tuple[str, date]], noaa20_first: date | None) -> list[date]:
    """Days on which NOAA-20 carries the series in place of S-NPP.

    `outages` holds (satellite, local date) pairs. A day is filled when S-NPP
    was out, NOAA-20 was not, NOAA-20 had started (`noaa20_first`) and S-NPP
    was still the carrier (before the second switch date).
    """
    if noaa20_first is None:
        return []
    outages = list(outages)
    snpp_out = {day for sat, day in outages if sat == "N"}
    noaa20_out = {day for sat, day in outages if sat == "N20"}
    return sorted(day for day in snpp_out - noaa20_out if noaa20_first <= day < config.SWITCH2_DATE)


def assign_weights(
    aqua: duckdb.DuckDBPyRelation,
    snpp: duckdb.DuckDBPyRelation,
    model: dict,
    noaa20: duckdb.DuckDBPyRelation | None = None,
    noaa20_model: dict | None = None,
    fill_days: Iterable[date] = (),
) -> duckdb.DuckDBPyRelation:
    """All pixel rows of the carriers, with `block`, `s`, `wk` and `w` added.

    `fill_days` are the days NOAA-20 carries in place of S-NPP; they are
    ignored when no NOAA-20 data is given.
    """
    start = config.SERIES_START.isoformat()
    switch = config.SWITCH_DATE.isoformat()
    switch2 = config.SWITCH2_DATE.isoformat()
    with_noaa20 = noaa20 is not None and noaa20_model is not None

    aqua_in_series = f"local_date >= DATE '{start}' AND local_date < DATE '{switch}'"
    out = aqua.query("a", f"""
        SELECT a.*, {BLOCK_SQL} AS block,
            CAST({aqua_in_series} AS INTEGER) AS s,
            1.0 / n_pix AS wk,
            CASE WHEN {aqua_in_series} THEN 1.0 / n_pix ELSE 0.0 END AS w
        FROM a
    """)

    snpp_in_series = f"local_date >= DATE '{switch}'"
    noaa20_in_series = f"local_date >= DATE '{switch2}'"
    if with_noaa20:
        snpp_in_series += f" AND local_date < DATE '{switch2}'"
        filled = ", ".join(f"DATE '{day.isoformat()}'" for day in sorted(set(fill_days)))
        if filled:
            snpp_in_series += f" AND local_date NOT IN ({filled})"
            noaa20_in_series = f"({noaa20_in_series} OR local_date IN ({filled}))"
    out = out.union(_viirs_weighted(snpp, model, snpp_in_series))
    if with_noaa20:
        out = out.union(_viirs_weighted(noaa20, noaa20_model, noaa20_in_series))
    return out
