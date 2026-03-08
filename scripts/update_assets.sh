#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS_DIR="${ROOT_DIR}/assets"
mkdir -p "${ASSETS_DIR}"

curl -sS "https://data.cms.gov/mmd-population/assets/strings.json" -o "${ASSETS_DIR}/strings.json"
curl -sS "https://data.cms.gov/mmd-population/js/menus.js" -o "${ASSETS_DIR}/menus.js"
curl -sS "https://data.cms.gov/mmd-population/assets/codebook_crosswalk.csv" -o "${ASSETS_DIR}/codebook_crosswalk.csv"
curl -sS "https://data.cms.gov/mmd-population/assets/countynames.tsv" -o "${ASSETS_DIR}/countynames.tsv"
curl -sS "https://data.cms.gov/mmd-population/assets/F7FDCF9D-F44B-4A31-B751-5A5FEB29084E?urban.tsv" -o "${ASSETS_DIR}/urban.tsv"

echo "Updated local CMS assets in ${ASSETS_DIR}"
