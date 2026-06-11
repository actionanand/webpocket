# webpocket

`webpocket` is a mobile-first Express app for saving web pages for offline reading.

## Current Features

- Save a URL as a full single HTML page with styles and fetched assets embedded.
- Save or download an optimized low-data HTML copy when you explicitly choose optimization.
- Download a URL as a ZIP with `index.html` and an `assets/` folder.
- Capture login-protected pages by sending a bearer token, cookies, custom request headers, or storage key/value tokens with the save request.
- Import a single HTML file, an optimized HTML file, a ZIP archive, or a browser-saved `name.html` + `name_files/` folder.
- Convert uploaded HTML-with-assets packages into one single HTML file.
- Show saved page size with saved date and time.
- Remove saved pages from the library to free storage.
- Open the live source page in a new browser tab from saved pages.
- Read saved pages from a local library without internet access.
- PWA-ready shell for future Android APK/AAB packaging work.

## Setup

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the capture modes, button meanings, storage model, routes, and package explanations.

## Notes For Android Later

The app is already shaped as a mobile-first local web app. Later you can package it with a wrapper such as Capacitor, a WebView shell, or a Trusted Web Activity depending on whether the Android app should run a local server or connect to a hosted instance.

Saved pages are stored under `storage/pages/`. The folder is ignored by git so local offline content is not committed accidentally.

## Authenticated Capture

Open **Authenticated page options** on the home page when a URL requires a login token or session cookie. You can provide:

- a bearer token, which is sent as `Authorization: Bearer ...`;
- a raw `Cookie` header such as `session=...; csrf=...`;
- request headers as a JSON object;
- a local storage key and value, such as key `accessToken` and its token value;
- a session storage key and value, such as key `sessionToken` and its token value.

Token-like local/session storage keys are automatically used as bearer tokens when the bearer-token field is empty. Header values can also reference them with templates like `Bearer {{localStorage.accessToken}}` or `Bearer {{sessionStorage.sessionToken}}`.

For safety, auth headers are sent only to the target page origin and same-origin assets unless you enable the cross-origin assets checkbox for trusted domains.

## Capture Note

The single-page mode preserves fetched HTML, CSS, images, icons, and CSS-referenced assets where possible while removing executable scripts and auto-redirect metadata. Authenticated capture replays credentials through HTTP headers/cookies; sites that require client-side JavaScript execution before content appears may still need a browser-rendered capture engine in the future.
