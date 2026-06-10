# webpocket

`webpocket` is a mobile-first Express app for saving small, optimized web pages for offline reading.

## Current Features

- Save a URL as an optimized offline page.
- Download a URL as a single lightweight HTML file.
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
