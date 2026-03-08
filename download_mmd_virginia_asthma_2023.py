#!/usr/bin/env python3
"""Download CMS MMD population data for Virginia / 2023 / Asthma.

This script uses the direct CMS endpoint that powers the MMD Population tool:
https://data.cms.gov/data-api/v1/mmd-tool/

It resolves measure-to-source mappings from the same tool assets used by the UI,
then paginates through the API, filters to Virginia, and exports JSON + CSV.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Set
from urllib.parse import urlencode
from urllib.request import urlopen

BASE_URL = "https://data.cms.gov"
MMD_API = f"{BASE_URL}/data-api/v1/mmd-tool/"
MENUS_JS_URL = f"{BASE_URL}/mmd-population/js/menus.js"
STRINGS_JSON_URL = f"{BASE_URL}/mmd-population/assets/strings.json"
CROSSWALK_CSV_URL = f"{BASE_URL}/mmd-population/assets/codebook_crosswalk.csv"
COUNTY_NAMES_TSV_URL = f"{BASE_URL}/mmd-population/assets/countynames.tsv"
URBAN_TSV_URL = (
    f"{BASE_URL}/mmd-population/assets/F7FDCF9D-F44B-4A31-B751-5A5FEB29084E?urban.tsv"
)


@dataclass(frozen=True)
class FetchOptions:
    population: str
    year: str
    elig: str
    race_code: str
    sex_code: str
    adjust: str
    dual: str


DEFAULT_FETCH_OPTIONS = FetchOptions(
    population="f",
    year="23",
    elig=".",
    race_code=".",
    sex_code=".",
    adjust="1",
    dual=".",
)

MEASURE_LABEL_BY_CODE = {
    "p": "Average Principal Cost",
    "t": "Average Total Cost",
    "a": "Average Total Cost (Risk-adjusted)",
    "e": "Emergency Department Visit Rate",
    "h": "Hospitalization",
    "v": "Prevalence",
}

CSV_COLUMNS = [
    "population",
    "year",
    "geography",
    "measure",
    "adjustment",
    "analysis",
    "domain",
    "condition",
    "primary_sex",
    "primary_age",
    "primary_dual",
    "fips",
    "county",
    "state",
    "urban",
    "primary_race",
    "primary_eligibility",
    "primary_denominator",
    "analysis_value",
]


def fetch_text(url: str, retries: int = 3, sleep_seconds: float = 1.0) -> str:
    last_exc = None
    for attempt in range(1, retries + 1):
        try:
            with urlopen(url) as resp:
                raw = resp.read()
                try:
                    return raw.decode("utf-8")
                except UnicodeDecodeError:
                    # Some legacy MMD assets contain non-UTF8 characters.
                    return raw.decode("latin-1")
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if attempt < retries:
                time.sleep(sleep_seconds * attempt)
    raise RuntimeError(f"Failed to fetch {url}: {last_exc}")


def fetch_json(url: str) -> object:
    return json.loads(fetch_text(url))


def fetch_csv_rows(url: str) -> List[Dict[str, str]]:
    content = fetch_text(url)
    return list(csv.DictReader(content.splitlines()))


def fetch_tsv_rows(url: str) -> List[Dict[str, str]]:
    content = fetch_text(url)
    return list(csv.DictReader(content.splitlines(), delimiter="\t"))


def get_condition_code_and_measures(condition_label: str) -> tuple[str, List[str]]:
    strings = fetch_json(STRINGS_JSON_URL)
    if not isinstance(strings, dict):
        raise RuntimeError("Unexpected strings.json format.")

    menus_js = fetch_text(MENUS_JS_URL)
    pattern = re.compile(
        r"\{'disp':\s*get_string_by_id\(\"(?P<string_id>[^\"]+)\"\),\s*"
        r"'val':\s*'(?P<val>[^']+)',\s*'header':\s*(?P<header>true|false),\s*"
        r"'domain':\s*(?P<domain>[^,]+),\s*'measure':\s*'(?P<measure>[^']+)'"
    )

    entries = []
    for match in pattern.finditer(menus_js):
        string_id = match.group("string_id")
        translated = strings.get(string_id)
        english = translated.get("english") if isinstance(translated, dict) else None
        entries.append(
            {
                "label": english,
                "val": match.group("val"),
                "measure_chars": match.group("measure"),
            }
        )

    matches = [entry for entry in entries if entry["label"] == condition_label]
    if not matches:
        raise RuntimeError(f"Condition label not found in menus: {condition_label}")

    condition_code = matches[0]["val"]
    measure_chars = sorted(set("".join(m["measure_chars"] for m in matches)))
    return condition_code, measure_chars


def resolve_sources_for_measures(
    measure_codes: Iterable[str], options: FetchOptions
) -> Dict[str, str]:
    rows = fetch_csv_rows(CROSSWALK_CSV_URL)
    dimensions = [
        "population",
        "measure",
        "year",
        "elig",
        "race_code",
        "sex_code",
        "adjust",
        "dual",
    ]
    option_map = {
        "population": options.population,
        "year": options.year,
        "elig": options.elig,
        "race_code": options.race_code,
        "sex_code": options.sex_code,
        "adjust": options.adjust,
        "dual": options.dual,
    }

    resolved: Dict[str, str] = {}
    for measure in measure_codes:
        option_map["measure"] = measure
        chosen = None
        for row in rows:
            criteria = [k for k in dimensions if row.get(k, "") != ""]
            ok = True
            for key in criteria:
                if row[key].find(option_map[key]) == -1:
                    ok = False
                    break
            if ok:
                chosen = row
                break

        if not chosen:
            raise RuntimeError(
                f"No crosswalk source matched measure={measure} and options={option_map}"
            )
        resolved[measure] = chosen["url"]
    return resolved


def fetch_measure_rows(
    source: str,
    year: str,
    measure: str,
    condition_code: str,
    geography: str,
    page_size: int,
) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    offset = 0
    while True:
        params = {
            "_source": source,
            "year": year,
            "geography": geography,
            "measure": measure,
            "condition": condition_code,
            "sexcat": ".",
            "agecat": ".",
            "dual": ".",
            "eligcat": ".",
            "racecat": ".",
            "fltr": "1",
            "_size": str(page_size),
            "_offset": str(offset),
        }
        url = f"{MMD_API}?{urlencode(params)}"
        page = fetch_json(url)
        if not isinstance(page, list):
            raise RuntimeError(f"Unexpected API response for {url}")
        if not page:
            break
        out.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return out


def filter_virginia(rows: List[Dict[str, str]], geography: str, state_fips: str) -> List[Dict[str, str]]:
    if geography == "s":
        return [row for row in rows if row.get("fips") == state_fips]
    return [row for row in rows if str(row.get("fips", "")).startswith(state_fips)]


def write_json(path: Path, rows: List[Dict[str, str]]) -> None:
    path.write_text(json.dumps(rows, indent=2), encoding="utf-8")


def write_csv(path: Path, rows: List[Dict[str, str]], fieldnames: List[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def get_name_maps() -> tuple[Dict[str, str], Dict[str, str], Set[str]]:
    county_rows = fetch_tsv_rows(COUNTY_NAMES_TSV_URL)
    urban_rows = fetch_tsv_rows(URBAN_TSV_URL)

    state_name_by_fips2: Dict[str, str] = {}
    county_name_by_fips5: Dict[str, str] = {}
    for row in county_rows:
        fips = (row.get("id") or "").strip()
        name = (row.get("name") or "").strip()
        if len(fips) == 2:
            state_name_by_fips2[fips] = name
        elif len(fips) == 5:
            county_name_by_fips5[fips] = name

    urban_counties = {(row.get("id") or "").strip() for row in urban_rows if row.get("id")}
    return state_name_by_fips2, county_name_by_fips5, urban_counties


def to_export_row(
    row: Dict[str, str],
    condition_label: str,
    state_name_by_fips2: Dict[str, str],
    county_name_by_fips5: Dict[str, str],
    urban_counties: Set[str],
) -> Dict[str, str]:
    geography_code = row.get("geography", "")
    fips_raw = str(row.get("fips", "")).zfill(5 if geography_code == "c" else 2)
    state_fips = fips_raw[:2]
    state_name = state_name_by_fips2.get(state_fips, "")
    county_name = county_name_by_fips5.get(fips_raw, "") if geography_code == "c" else ""

    sexcat = row.get("sexcat", ".")
    agecat = row.get("agecat", ".")
    dual = row.get("dual", ".")
    racecat = row.get("racecat", ".")
    eligcat = row.get("eligcat", ".")
    fltr = row.get("fltr", "")

    adjustment = {
        "1": "Unsmoothed actual",
        "2": "Smoothed",
    }.get(fltr, "Unsmoothed actual")

    export = {
        "population": "Medicare Fee For Service",
        "year": f"20{row.get('year', '')}",
        "geography": "County" if geography_code == "c" else "State",
        "measure": MEASURE_LABEL_BY_CODE.get(row.get("measure", ""), row.get("measure", "")),
        "adjustment": adjustment,
        "analysis": "Base measure",
        "domain": "Primary chronic conditions",
        "condition": condition_label,
        "primary_sex": "All" if sexcat == "." else sexcat,
        "primary_age": "All" if agecat == "." else agecat,
        "primary_dual": "Dual & non-dual" if dual == "." else dual,
        "fips": str(int(fips_raw)) if fips_raw.isdigit() else fips_raw,
        "county": county_name,
        "state": state_name,
        "urban": "Urban" if geography_code == "c" and fips_raw in urban_counties else "",
        "primary_race": "All" if racecat == "." else racecat,
        "primary_eligibility": "All" if eligcat == "." else eligcat,
        "primary_denominator": row.get("dencat", "undefined") or "undefined",
        "analysis_value": row.get("rate", ""),
    }
    return export


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download Virginia 2023 Asthma data from CMS MMD API."
    )
    parser.add_argument("--output-dir", default="/tmp/mmd_virginia_2023_asthma")
    parser.add_argument("--state-fips", default="51")
    parser.add_argument("--year", default="23", help="MMD year code (23 == 2023).")
    parser.add_argument("--condition-label", default="Asthma")
    parser.add_argument("--page-size", type=int, default=5000)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    state_name_by_fips2, county_name_by_fips5, urban_counties = get_name_maps()

    condition_code, measure_codes = get_condition_code_and_measures(args.condition_label)
    sources = resolve_sources_for_measures(measure_codes, DEFAULT_FETCH_OPTIONS)

    combined_rows: List[Dict[str, str]] = []
    summary = {
        "state_fips": args.state_fips,
        "year_code": args.year,
        "condition_label": args.condition_label,
        "condition_code": condition_code,
        "measures": {},
    }

    for measure in measure_codes:
        source = sources[measure]
        county_rows = fetch_measure_rows(
            source=source,
            year=args.year,
            measure=measure,
            condition_code=condition_code,
            geography="c",
            page_size=args.page_size,
        )
        state_rows = fetch_measure_rows(
            source=source,
            year=args.year,
            measure=measure,
            condition_code=condition_code,
            geography="s",
            page_size=args.page_size,
        )

        county_va = filter_virginia(county_rows, geography="c", state_fips=args.state_fips)
        state_va = filter_virginia(state_rows, geography="s", state_fips=args.state_fips)

        annotated = []
        export_rows = []
        for row in county_va + state_va:
            enriched = dict(row)
            enriched["_source"] = source
            enriched["_measure_code"] = measure
            annotated.append(enriched)
            export_rows.append(
                to_export_row(
                    row=enriched,
                    condition_label=args.condition_label,
                    state_name_by_fips2=state_name_by_fips2,
                    county_name_by_fips5=county_name_by_fips5,
                    urban_counties=urban_counties,
                )
            )

        combined_rows.extend(annotated)

        write_json(output_dir / f"measure_{measure}_virginia.json", annotated)
        write_csv(output_dir / f"measure_{measure}_virginia.csv", export_rows, CSV_COLUMNS)

        summary["measures"][measure] = {
            "source": source,
            "county_rows_total": len(county_rows),
            "county_rows_virginia": len(county_va),
            "state_rows_total": len(state_rows),
            "state_rows_virginia": len(state_va),
        }

    write_json(output_dir / "virginia_2023_asthma_all_measures.json", combined_rows)
    combined_export_rows = [
        to_export_row(
            row=row,
            condition_label=args.condition_label,
            state_name_by_fips2=state_name_by_fips2,
            county_name_by_fips5=county_name_by_fips5,
            urban_counties=urban_counties,
        )
        for row in combined_rows
    ]
    write_csv(
        output_dir / "virginia_2023_asthma_all_measures.csv",
        combined_export_rows,
        CSV_COLUMNS,
    )
    write_json(output_dir / "download_summary.json", [summary])

    print(f"Wrote outputs to: {output_dir}")
    print(f"Condition code: {condition_code}")
    print(f"Measures: {','.join(measure_codes)}")
    print(f"Combined rows: {len(combined_rows)}")


if __name__ == "__main__":
    main()
