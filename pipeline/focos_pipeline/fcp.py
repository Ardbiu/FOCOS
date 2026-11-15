"""Fire cell-passes (section 4.3), the unit both sensors are counted in.

One FCP is one distinct (0.01-degree cell, local date, day or night) for one
sensor. Every pixel row keeps its FCP id, the FCP's pixel count and, from
that, a strength class.
"""
from __future__ import annotations

from datetime import date

import duckdb

FCP_PARTITION = "sat, cell01_lat, cell01_lon, local_date, dn"


def add_fcp_keys(table: duckdb.DuckDBPyRelation) -> duckdb.DuckDBPyRelation:
    """Add cell01_lat, cell01_lon, fcp_id, n_pix and strength to every pixel row."""
    return table.query("pixels", f"""
        WITH keyed AS (
            SELECT *,
                -- round before flooring: -34.01 * 100 is -3401.0000000000005 in floats
                CAST(floor(round(lat * 100, 6)) AS INTEGER) AS cell01_lat,
                CAST(floor(round(lon * 100, 6)) AS INTEGER) AS cell01_lon
            FROM pixels
        ),
        counted AS (
            SELECT *,
                hash(sat, cell01_lat, cell01_lon, local_date, dn) AS fcp_id,
                CAST(count(*) OVER (PARTITION BY {FCP_PARTITION}) AS INTEGER) AS n_pix
            FROM keyed
        )
        SELECT *,
            CASE WHEN n_pix = 1 THEN 1 WHEN n_pix <= 3 THEN 2 ELSE 3 END AS strength
        FROM counted
    """)


def fcp_counts(table: duckdb.DuckDBPyRelation, by: list[str]) -> duckdb.DuckDBPyRelation:
    """Distinct FCPs and pixel rows per group of the `by` columns."""
    cols = ", ".join(by)
    return table.query("keyed", f"""
        SELECT {cols}, count(DISTINCT fcp_id) AS fcp, count(*) AS pixels
        FROM keyed GROUP BY {cols}
    """)


def outage_days(
    table: duckdb.DuckDBPyRelation, sensor: str, min_expected: float = 10.0
) -> set[date]:
    """Local dates when the sensor was silent although fire was clearly burning.

    A day is an outage when the sensor reports nothing at all, or nothing by
    day, while another satellite saw enough fire that this sensor, at its usual
    ratio to that satellite, would have been expected to report at least
    `min_expected` pixels (in total, or by day). A quiet day when nobody saw
    much is data, not an outage.
    """
    if not sensor.isalnum():
        raise ValueError(f"bad sensor code: {sensor!r}")
    rows = table.query("pixels", f"""
        WITH daily AS (
            SELECT local_date, sat, count(*) AS n_all, count(*) FILTER (WHERE dn = 'D') AS n_day
            FROM pixels GROUP BY local_date, sat
        ),
        own AS (SELECT local_date, n_all, n_day FROM daily WHERE sat = '{sensor}'),
        span AS (SELECT min(local_date) AS lo, max(local_date) AS hi FROM own),
        ratios AS (  -- usual ratio to each other satellite, on days both reported
            SELECT other.sat,
                sum(own.n_all) * 1.0 / sum(other.n_all) AS r_all,
                sum(own.n_day) * 1.0 / nullif(sum(other.n_day), 0) AS r_day
            FROM daily AS other JOIN own USING (local_date)
            WHERE other.sat <> '{sensor}'
            GROUP BY other.sat
        ),
        expected AS (
            SELECT other.local_date,
                max(other.n_all * ratios.r_all) AS e_all,
                max(other.n_day * ratios.r_day) AS e_day
            FROM daily AS other JOIN ratios USING (sat)
            GROUP BY other.local_date
        )
        SELECT expected.local_date
        FROM expected CROSS JOIN span LEFT JOIN own ON own.local_date = expected.local_date
        WHERE expected.local_date BETWEEN span.lo AND span.hi
          AND (
            (own.local_date IS NULL AND expected.e_all >= {float(min_expected)})
            OR (coalesce(own.n_day, 0) = 0 AND expected.e_day >= {float(min_expected)})
          )
    """).fetchall()
    return {row[0] for row in rows}
