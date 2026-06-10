# webpocket

`webpocket` is a mobile-first Express app for saving web pages for offline reading.

## Current Features

- Save a URL as a full single HTML page with styles and fetched assets embedded.
- Save or download an optimized low-data HTML copy when you explicitly choose optimization.
- Download a URL as a ZIP with `index.html` and an `assets/` folder.
- Import a single HTML file, an optimized HTML file, a ZIP archive, or an HTML folder with assets.
- Read saved pages from a local library without internet access.
- PWA-ready shell for future Android APK/AAB packaging work.

## Setup

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Notes For Android Later

The app is already shaped as a mobile-first local web app. Later you can package it with a wrapper such as Capacitor, a WebView shell, or a Trusted Web Activity depending on whether the Android app should run a local server or connect to a hosted instance.

Saved pages are stored under `storage/pages/`. The folder is ignored by git so local offline content is not committed accidentally.

## Capture Note

The single-page mode preserves fetched HTML, CSS, images, icons, and CSS-referenced assets where possible while removing executable scripts and auto-redirect metadata. Browser extensions such as SingleFile can also capture pages after client-side JavaScript has rendered them; adding that level of fidelity later would require a browser-rendered capture engine.
