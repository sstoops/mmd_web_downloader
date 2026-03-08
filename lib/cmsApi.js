const BASE_URL = "https://data.cms.gov";
const URLS = {
  strings: "./assets/strings.json",
  menusJs: "./assets/menus.js",
  crosswalk: "./assets/codebook_crosswalk.csv",
  countyNames: "./assets/countynames.tsv",
  urban: "./assets/urban.tsv",
  mmdApi: `${BASE_URL}/data-api/v1/mmd-tool/`,
};

export const MEASURE_LABEL_BY_CODE = {
  p: "Average Principal Cost",
  t: "Average Total Cost",
  a: "Average Total Cost (Risk-adjusted)",
  e: "Emergency Department Visit Rate",
  h: "Hospitalization",
  m: "Mortality",
  v: "Prevalence",
  q: "Prevention Quality Indicator (PQI)",
  c: "Preventive Services",
  r: "Readmissions",
};

export const CSV_COLUMNS = [
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
];

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("iso-8859-1").decode(buffer);
  }
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function parseDelimited(text, delimiter = ",") {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(delimiter);
  return lines.slice(1).map((line) => {
    const parts = line.split(delimiter);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = parts[index] ?? "";
    });
    return row;
  });
}

function parseCsvWithQuotes(text) {
  text = text.replace(/\r/g, "");
  const rows = [];
  let current = "";
  let inQuotes = false;
  const records = [];

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "\n" && !inQuotes) {
      records.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) records.push(current);

  const splitLine = (line) => {
    const cols = [];
    let buf = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      const n = line[i + 1];
      if (c === '"' && quoted && n === '"') {
        buf += '"';
        i += 1;
        continue;
      }
      if (c === '"') {
        quoted = !quoted;
        continue;
      }
      if (c === "," && !quoted) {
        cols.push(buf);
        buf = "";
        continue;
      }
      buf += c;
    }
    cols.push(buf);
    return cols;
  };

  if (!records.length) return [];
  const headers = splitLine(records[0]).map((h) => h.trim());
  for (let i = 1; i < records.length; i += 1) {
    if (!records[i].trim()) continue;
    const cols = splitLine(records[i]);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = (cols[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return rows;
}

export async function loadAssets() {
  const [strings, menusJs, crosswalkCsv, countyTsv, urbanTsv] = await Promise.all(
    [
      fetchJson(URLS.strings),
      fetchText(URLS.menusJs),
      fetchText(URLS.crosswalk),
      fetchText(URLS.countyNames),
      fetchText(URLS.urban),
    ],
  );

  const crosswalkRows = parseCsvWithQuotes(crosswalkCsv);
  const countyRows = parseDelimited(countyTsv, "\t");
  const urbanRows = parseDelimited(urbanTsv, "\t");
  return { strings, menusJs, crosswalkRows, countyRows, urbanRows };
}

export function parseConditions(menusJs, strings) {
  const pattern =
    /\{'disp':\s*get_string_by_id\("([^"]+)"\),\s*'val':\s*'([^']+)',\s*'header':\s*(true|false),\s*'domain':\s*([^,]+),\s*'measure':\s*'([^']+)'/g;

  const dedup = new Map();
  let match = pattern.exec(menusJs);
  while (match) {
    const stringId = match[1];
    const conditionCode = match[2];
    const measureMask = match[5];
    const english = strings?.[stringId]?.english;
    if (english) {
      const key = `${conditionCode}::${english}`;
      const existing = dedup.get(key) || {
        label: english,
        code: conditionCode,
        measureMask: "",
      };
      existing.measureMask += measureMask;
      dedup.set(key, existing);
    }
    match = pattern.exec(menusJs);
  }
  return [...dedup.values()].map((item) => ({
    label: item.label,
    code: item.code,
    measureSet: [...new Set(item.measureMask.split(""))],
  }));
}

export function parseYears(crosswalkRows) {
  const yearCodes = new Set();
  for (const row of crosswalkRows) {
    const yearCode = row.year;
    if (/^\d{1,2}$/.test(yearCode) && Number(yearCode) >= 2 && Number(yearCode) <= 23) {
      yearCodes.add(yearCode);
    }
  }
  return [...yearCodes]
    .sort((a, b) => Number(b) - Number(a))
    .map((code) => ({ code, label: `20${code.padStart(2, "0")}` }));
}

export function parseStates(countyRows) {
  return countyRows
    .filter((row) => /^\d{2}$/.test(row.id))
    .map((row) => ({ fips: row.id, label: row.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function parseLookups(countyRows, urbanRows) {
  const stateByFips2 = {};
  const countyByFips5 = {};
  countyRows.forEach((row) => {
    if (/^\d{2}$/.test(row.id)) stateByFips2[row.id] = row.name;
    if (/^\d{5}$/.test(row.id)) countyByFips5[row.id] = row.name;
  });
  const urbanFipsSet = new Set(
    urbanRows.filter((row) => /^\d{5}$/.test(row.id)).map((row) => row.id),
  );
  return { stateByFips2, countyByFips5, urbanFipsSet };
}

function rowMatchesSelection(row, selection) {
  const dimensions = [
    "population",
    "measure",
    "year",
    "elig",
    "race_code",
    "sex_code",
    "adjust",
    "dual",
  ];
  const criteria = dimensions.filter((dim) => row[dim] !== "");
  return criteria.every((dim) => row[dim].includes(selection[dim]));
}

export function resolveSource(crosswalkRows, selection) {
  const chosen = crosswalkRows.find((row) => rowMatchesSelection(row, selection));
  return chosen?.url || null;
}

export function availableMeasures(crosswalkRows, yearCode) {
  const set = new Set();
  for (const row of crosswalkRows) {
    if (row.population.includes("f") && row.year.includes(yearCode)) {
      set.add(row.measure);
    }
  }
  return [...set].sort();
}

export async function fetchMmdRows({
  source,
  year,
  geography,
  measure,
  condition,
  adjustment,
  pageSize = 5000,
}) {
  const rows = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      _source: source,
      year,
      geography,
      measure,
      condition,
      sexcat: ".",
      agecat: ".",
      dual: ".",
      eligcat: ".",
      racecat: ".",
      fltr: adjustment,
      _size: String(pageSize),
      _offset: String(offset),
    });
    const response = await fetch(`${URLS.mmdApi}?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`MMD API request failed: ${response.status}`);
    }
    const page = await response.json();
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

export function toExportRow(row, conditionLabel, lookups) {
  const geographyCode = row.geography;
  const rawFips = String(row.fips || "");
  const fips = geographyCode === "c" ? rawFips.padStart(5, "0") : rawFips.padStart(2, "0");
  const stateFips = fips.slice(0, 2);

  return {
    population: "Medicare Fee For Service",
    year: `20${String(row.year).padStart(2, "0")}`,
    geography: geographyCode === "c" ? "County" : "State",
    measure: MEASURE_LABEL_BY_CODE[row.measure] || row.measure,
    adjustment: row.fltr === "2" ? "Unsmoothed age adjusted" : "Unsmoothed actual",
    analysis: "Base measure",
    domain: "Primary chronic conditions",
    condition: conditionLabel,
    primary_sex: row.sexcat === "." ? "All" : row.sexcat,
    primary_age: row.agecat === "." ? "All" : row.agecat,
    primary_dual: row.dual === "." ? "Dual & non-dual" : row.dual,
    fips: String(Number(fips)),
    county: geographyCode === "c" ? lookups.countyByFips5[fips] || "" : "",
    state: lookups.stateByFips2[stateFips] || "",
    urban: geographyCode === "c" && lookups.urbanFipsSet.has(fips) ? "Urban" : "",
    primary_race: row.racecat === "." ? "All" : row.racecat,
    primary_eligibility: row.eligcat === "." ? "All" : row.eligcat,
    primary_denominator: row.dencat || "undefined",
    analysis_value: row.rate || "",
  };
}
