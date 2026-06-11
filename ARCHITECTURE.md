# webpocket Architecture

`webpocket` is a mobile-first Express app for saving web pages and reading them later without depending on the original website. The app has two main jobs:

- Capture or import offline page files.
- Store those files locally and present them through a simple reader UI.

## App Shape

```text
Browser UI
  -> Express routes in src/app.js
  -> Capture/import logic in src/lib/capture.js
  -> HTML rewriting in src/lib/htmlOptimizer.js
  -> Local page storage in src/lib/storage.js
  -> Saved files under storage/pages/
```

The frontend is server-rendered with EJS views in `views/`. Static files such as CSS, JavaScript, icons, the manifest, and the service worker live in `public/`.

## Why There Are Multiple Buttons

Offline saving has tradeoffs. A single button would hide important choices from the user, especially when some users care about low data and others care about page fidelity.

### Save Single Page

This is the default recommended action.

It saves the page into the local webpocket library as one `index.html` file. The app tries to embed fetched CSS, images, icons, and CSS-referenced assets directly into the HTML using data URIs.

Use this when:

- You want the closest simple offline copy.
- You want to read the page inside webpocket later.
- You do not specifically need a separate assets folder.

Tradeoff: the file can become large because images and styles are embedded inside the HTML.

### Single HTML

This creates the same kind of full single-page copy, but downloads it immediately instead of saving it into the webpocket library.

Use this when:

- You want to keep or share one standalone `.html` file.
- You do not need the page listed in the local library.

Tradeoff: it is a download action, not a library action.

### ZIP + Assets

This downloads a ZIP file containing `index.html` plus an `assets/` folder.

Use this when:

- You prefer a normal website-like folder structure.
- You want images, CSS, icons, and CSS-referenced assets as separate files.
- You plan to move the offline page outside webpocket.

Tradeoff: it is less convenient than one HTML file, but easier to inspect and closer to a traditional saved webpage.

### Save Assets

This is the library version of `ZIP + Assets`.

It saves `index.html` and an `assets/` folder into `storage/pages/`, then opens the page in the webpocket reader.

Use this when:

- You want a fuller offline copy stored in the app.
- You want assets kept as files rather than embedded into one HTML file.

Tradeoff: the saved page has multiple files, so it depends on webpocket serving that folder correctly.

### Optimize Save

This saves a low-data reader-style copy into the webpocket library.

The optimizer removes scripts, common ad/sponsored blocks, heavy embeds, forms, stylesheets, and replaces images with text notes. This is intentionally destructive because the goal is a smaller readable document.

Use this when:

- You are on limited data.
- You mostly care about text.
- You accept that the page will not look like the original site.

Tradeoff: page layout and images are intentionally reduced.

### Optimize HTML

This downloads the optimized low-data HTML immediately instead of saving it into the library.

Use this when:

- You want a small standalone `.html` file.
- You do not need the page listed in webpocket.

Tradeoff: same reduced fidelity as `Optimize Save`.

## Capture Modes

### Full Single-Page Capture

Implemented in `src/lib/capture.js`.

The app fetches the source HTML, parses it with Cheerio, removes offline-breaking metadata and scripts, then tries to inline:

- Stylesheets
- Images
- `srcset` candidates
- Icons
- CSS `url(...)` assets

This is inspired by browser extensions such as SingleFile, but it is not identical. Browser extensions can capture the page after JavaScript has rendered it in a real browser. This server-side version captures the fetched HTML response. A future browser-rendered capture engine would improve support for JavaScript-heavy sites.

### HTML With Assets

Implemented in `src/lib/capture.js` and `src/lib/htmlOptimizer.js`.

The app fetches known assets and rewrites links so `index.html` points to files inside `assets/`. CSS files are also scanned for `url(...)` references so fonts and background images can be saved when possible.

### Optimized HTML

Implemented in `src/lib/htmlOptimizer.js`.

The optimizer creates a smaller reading copy by stripping heavy or interactive elements. This mode exists because full-page saving and low-data reading are different goals.

## Storage Model

Saved pages are stored under `storage/pages/`.

Each page gets a generated ID folder:

```text
storage/pages/
  20260610120000-ab12cd34/
    metadata.json
    content/
      index.html
      assets/
```

`metadata.json` stores the page title, source URL, capture kind, entry file, and timestamps. The reader route loads this metadata and displays the saved content in an iframe.

The metadata also stores `sizeBytes`, which is calculated from the files inside the saved page's `content/` folder. The library and recent-save cards display this size with the saved date and time.

## Browser-Saved HTML Uploads

Browsers such as Chrome commonly save pages as:

```text
name.html
name_files/
  image.png
  style.css
  other-assets...
```

webpocket supports this structure through the folder upload flow.

`Import with assets` preserves the browser-saved package as HTML plus its `_files` folder. The reader serves the HTML and local folder together.

`Convert to single HTML` reads the same uploaded package, finds local references such as `name_files/style.css` or `name_files/image.png`, and embeds those resources into one saved `index.html` using data URIs.

This conversion works for common local references in:

- Stylesheets
- CSS `url(...)` assets
- Images
- `srcset` image candidates
- Icons
- Video posters

## Removing Saved Pages

Saved pages can be removed from the library or reader. Delete actions remove the whole saved page folder under `storage/pages/`, including `metadata.json`, `index.html`, and any assets. The UI asks for confirmation and reports how much storage was freed.

## Live Source Links

Saved pages with a `sourceUrl` expose a `Live` button. It opens the original URL in a new browser tab using `target="_blank"` and `rel="noopener noreferrer"`.

## Main Routes

- `GET /` renders the capture/import screen.
- `POST /capture` handles URL capture and download actions.
- `POST /upload` imports HTML, ZIP, or folder uploads.
- `GET /library` lists saved pages.
- `GET /reader/:id` opens a saved page.
- `GET /library/:id/content/...` serves saved page files.
- `GET /download/:id/html` downloads the saved entry HTML.
- `GET /download/:id/zip` downloads the saved page folder as a ZIP.

## Packages Used

### express

Used for the HTTP server, routing, static file serving, form handling, and response downloads.

### ejs

Used for server-rendered HTML templates in `views/`. This keeps the first version simple and works well for a mobile-first app that may later be wrapped for Android.

### multer

Used for file uploads. It handles uploaded HTML files, ZIP archives, and folder-style multi-file uploads.

### adm-zip

Used to read imported ZIP archives and create ZIP downloads for saved pages.

### cheerio

Used to parse and rewrite HTML on the server. It powers title extraction, asset discovery, link rewriting, optimization, and single-page capture transformations.

### mime-types

Used to detect content types when serving saved files from `storage/pages/`, so HTML, CSS, images, and other assets are sent with appropriate headers.

## Public Assets And PWA Shell

The app includes:

- `public/favicon.ico`
- `public/favicon.svg`
- `public/icons/icon.svg`
- `public/manifest.webmanifest`
- `public/sw.js`

The service worker caches static app shell assets only. It intentionally does not cache rendered HTML pages like `/`, because stale cached UI previously caused old button labels to stay visible after code changes.

## Current Limitations

- JavaScript-rendered pages may not capture perfectly because the app fetches server HTML instead of using a real browser rendering engine.
- Sites that block server-side fetches or require login may return an error page.
- Some assets may be skipped if they exceed configured size limits.
- Full single-page HTML can become large when many images or fonts are embedded.

## Future Android Path

The app is structured so Android packaging can happen later without rewriting the core logic. Good future options include:

- Capacitor with a local or hosted Express backend.
- A WebView shell that talks to a local service.
- A hosted web app plus Android wrapper.
- A future browser-rendered capture worker for better SingleFile-like fidelity.
