# Public

Static assets served verbatim at the origin root by the dev server and the
production server — the pieces that make the web app installable and
offline-capable.

## What each file does

- `manifest.json` — the PWA manifest: the app's name, theme colors, display
  mode, and the icon set under `icons/`. `index.html` links it.
- `sw.js` — the hand-written service worker (no dependencies). Cache-first
  for immutable static assets, stale-while-revalidate for JS/CSS modules,
  network-first for navigations and GET API calls, passthrough for mutations
  and SSE streams.
- `icons/` — the app icons the manifest references.

## Where it lives and what consumes it

The folder lives at `public/`. The browser consumes it directly: `index.html`
links the manifest and icon, and the client registers `sw.js`; nothing
imports it as a module.
