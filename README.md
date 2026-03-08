# MMD County CSV Downloader (Web)

Standalone vanilla JavaScript web app that downloads county-level MMD data from CMS and exports a combined CSV.

## Features

- Separate project/repo from the Python downloader.
- User-selectable filters:
  - State
  - Year
  - Measure (single or all available)
  - Adjustment
  - Condition/Service
- County-level only download (`geography=c`).
- Combined CSV export in tool-like columns.
- Bundled CMS metadata assets for browser CORS compatibility.

## Local Run

Serve this directory with any static server:

```bash
cd /app/tools/mmd-downloader-web
python3 -m http.server 8000
```

Then open:

- [http://localhost:8000](http://localhost:8000)

## GitHub Pages Deployment

Because this is a static app (no backend), it can be deployed directly to GitHub Pages:

1. Push this directory as its own repo.
2. In GitHub repo settings, enable Pages from the default branch root.
3. Confirm the published site URL.

## Notes

- The app depends on public CMS endpoints and assets.
- CMS static assets are bundled locally (`assets/`) because those files are not
  CORS-enabled for browser apps.
- Live county data still comes directly from the CORS-enabled
  `data-api/v1/mmd-tool` endpoint.
- If CMS changes schemas/assets, refresh local `assets/` copies and update
  parsers as needed.
- Output is county-only by design (state rows are excluded).
