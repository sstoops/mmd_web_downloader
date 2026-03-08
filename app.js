import {
  CSV_COLUMNS,
  MEASURE_LABEL_BY_CODE,
  availableMeasures,
  fetchMmdRows,
  loadAssets,
  parseConditions,
  parseLookups,
  parseStates,
  parseYears,
  resolveSource,
  toExportRow,
} from "./lib/cmsApi.js";
import { downloadCsv, toCsv } from "./lib/csvExport.js";

const els = {
  form: document.getElementById("download-form"),
  state: document.getElementById("state"),
  year: document.getElementById("year"),
  measure: document.getElementById("measure"),
  adjustment: document.getElementById("adjustment"),
  condition: document.getElementById("condition"),
  button: document.getElementById("download-btn"),
  status: document.getElementById("status"),
};

const state = {
  assets: null,
  lookups: null,
  conditions: [],
  years: [],
  states: [],
};

function setStatus(message) {
  els.status.textContent = message;
}

function setBusy(isBusy) {
  els.button.disabled = isBusy;
  els.state.disabled = isBusy;
  els.year.disabled = isBusy;
  els.measure.disabled = isBusy;
  els.adjustment.disabled = isBusy;
  els.condition.disabled = isBusy;
}

function fillSelect(selectEl, options, valueKey = "value", labelKey = "label") {
  selectEl.innerHTML = "";
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = option[valueKey];
    opt.textContent = option[labelKey];
    selectEl.appendChild(opt);
  }
}

function refreshMeasureOptions() {
  const yearCode = els.year.value;
  const measures = availableMeasures(state.assets.crosswalkRows, yearCode).filter(
    (code) => MEASURE_LABEL_BY_CODE[code],
  );
  const options = [
    { value: "*", label: "All available measures" },
    ...measures.map((code) => ({
      value: code,
      label: MEASURE_LABEL_BY_CODE[code] || code,
    })),
  ];
  fillSelect(els.measure, options);
}

function refreshConditionOptions() {
  const selectedMeasure = els.measure.value;
  const yearMeasures = new Set(
    availableMeasures(state.assets.crosswalkRows, els.year.value),
  );
  const conditionOptions = state.conditions
    .filter((condition) => {
      const matchesYear = condition.measureSet.some((m) => yearMeasures.has(m));
      if (!matchesYear) return false;
      if (selectedMeasure === "*") return true;
      return condition.measureSet.includes(selectedMeasure);
    })
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((condition) => ({
      value: condition.code,
      label: condition.label,
    }));

  fillSelect(els.condition, conditionOptions);
}

function selectedConditionLabel() {
  const selected = els.condition.options[els.condition.selectedIndex];
  return selected?.textContent || "";
}

function selectedMeasureCodes() {
  const selectedMeasure = els.measure.value;
  if (selectedMeasure !== "*") return [selectedMeasure];

  const conditionCode = els.condition.value;
  const yearMeasures = new Set(
    availableMeasures(state.assets.crosswalkRows, els.year.value),
  );
  const condition = state.conditions.find((c) => c.code === conditionCode);
  if (!condition) return [...yearMeasures];
  return condition.measureSet.filter((m) => yearMeasures.has(m));
}

function initDropdowns() {
  fillSelect(
    els.state,
    state.states.map((s) => ({ value: s.fips, label: s.label })),
  );
  fillSelect(
    els.year,
    state.years.map((y) => ({ value: y.code, label: y.label })),
  );
  refreshMeasureOptions();
  refreshConditionOptions();
}

async function handleDownload(event) {
  event.preventDefault();
  setBusy(true);
  try {
    const stateFips = els.state.value;
    const yearCode = els.year.value;
    const adjustment = els.adjustment.value;
    const conditionCode = els.condition.value;
    const conditionLabel = selectedConditionLabel();

    const measures = selectedMeasureCodes();
    if (!measures.length) {
      throw new Error("No measures available for the current selections.");
    }
    setStatus(`Resolving ${measures.length} measure source(s)...`);

    const combined = [];
    for (const measure of measures) {
      const source = resolveSource(state.assets.crosswalkRows, {
        population: "f",
        measure,
        year: yearCode,
        elig: ".",
        race_code: ".",
        sex_code: ".",
        adjust: adjustment,
        dual: ".",
      });

      if (!source) {
        throw new Error(`No source resolved for measure "${measure}".`);
      }

      setStatus(`Fetching measure ${measure}...`);
      const rows = await fetchMmdRows({
        source,
        year: yearCode,
        geography: "c",
        measure,
        condition: conditionCode,
        adjustment,
      });

      const stateRows = rows.filter((row) => String(row.fips || "").startsWith(stateFips));
      combined.push(
        ...stateRows.map((row) => toExportRow(row, conditionLabel, state.lookups)),
      );
    }

    const csv = toCsv(combined, CSV_COLUMNS);
    const stateName = els.state.options[els.state.selectedIndex].textContent
      .toLowerCase()
      .replaceAll(/\s+/g, "_");
    const conditionFile = conditionLabel.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
    downloadCsv(
      `${stateName}_20${yearCode}_${conditionFile}_county_combined.csv`,
      csv,
    );
    setStatus(
      `Done. Downloaded ${combined.length} county row(s) across ${measures.length} measure(s).`,
    );
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function init() {
  setBusy(true);
  try {
    setStatus("Loading CMS assets...");
    const assets = await loadAssets();
    state.assets = assets;
    state.lookups = parseLookups(assets.countyRows, assets.urbanRows);
    state.conditions = parseConditions(assets.menusJs, assets.strings);
    state.years = parseYears(assets.crosswalkRows);
    state.states = parseStates(assets.countyRows);

    initDropdowns();
    setStatus("Ready.");
  } catch (error) {
    setStatus(`Initialization failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

els.year.addEventListener("change", () => {
  refreshMeasureOptions();
  refreshConditionOptions();
});
els.measure.addEventListener("change", refreshConditionOptions);
els.form.addEventListener("submit", handleDownload);

init();
