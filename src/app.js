const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const multer = require("multer");
const config = require("./config");
const storage = require("./lib/storage");
const {
  captureOptimizedHtml,
  captureSinglePageHtml,
  captureZipBuffer,
  importUploadedFiles,
  saveOptimizedPage,
  saveSinglePage,
  saveZipCapture
} = require("./lib/capture");

const app = express();
const upload = multer({
  dest: config.tmpDir,
  preservePath: true,
  limits: {
    fileSize: config.limits.maxUploadedBytes,
    files: 200
  }
});

app.set("view engine", "ejs");
app.set("views", config.viewsDir);
app.locals.appName = config.appName;

app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) {
    res.setHeader("cache-control", "no-store");
  }
  next();
});
app.use(express.static(config.publicDir, {
  etag: true,
  maxAge: "1h"
}));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function downloadName(title, extension) {
  return `${storage.safeName(title || "webpocket-page")}.${extension}`;
}

app.get("/", asyncRoute(async (req, res) => {
  const pages = await storage.listPages();
  res.render("index", {
    title: "webpocket",
    pages: pages.slice(0, 4),
    notice: req.query.notice || "",
    error: req.query.error || ""
  });
}));

app.get("/library", asyncRoute(async (req, res) => {
  res.render("library", {
    title: "Library",
    pages: await storage.listPages()
  });
}));

app.post("/capture", asyncRoute(async (req, res) => {
  const url = String(req.body.url || "").trim();
  const action = req.body.action || "save-single";

  if (action === "download-html") {
    const page = await captureSinglePageHtml(url);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${downloadName(page.title, "html")}"`);
    res.send(page.html);
    return;
  }

  if (action === "download-optimized") {
    const page = await captureOptimizedHtml(url);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${downloadName(page.title, "html")}"`);
    res.send(page.html);
    return;
  }

  if (action === "download-zip") {
    const page = await captureZipBuffer(url);
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-disposition", `attachment; filename="${downloadName(page.title, "zip")}"`);
    res.send(page.buffer);
    return;
  }

  const metadata = action === "save-optimized"
    ? await saveOptimizedPage(url)
    : action === "save-with-assets"
      ? await saveZipCapture(url)
      : await saveSinglePage(url);
  res.redirect(`/reader/${metadata.id}`);
}));

app.post("/upload", upload.array("offlineFiles", 200), asyncRoute(async (req, res) => {
  try {
    const metadata = await importUploadedFiles(req.files);
    res.redirect(`/reader/${metadata.id}`);
  } finally {
    await Promise.all((req.files || []).map((file) => fs.rm(file.path, { force: true })));
  }
}));

app.get("/reader/:id", asyncRoute(async (req, res) => {
  if (!(await storage.pageExists(req.params.id))) {
    res.status(404).render("error", { title: "Not found", message: "That saved page was not found." });
    return;
  }
  const page = await storage.readMetadata(req.params.id);
  res.render("reader", {
    title: page.title,
    page
  });
}));

app.get(/^\/library\/([^/]+)\/content(?:\/(.*))?$/, asyncRoute(async (req, res) => {
  const id = req.params[0];
  const requestedPath = req.params[1] || "";
  const { metadata, target, contentType } = await storage.getContentFile(id, requestedPath);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    const indexPath = path.join(requestedPath, "index.html");
    res.redirect(`/library/${metadata.id}/content/${indexPath.replace(/\\/g, "/")}`);
    return;
  }
  res.setHeader("content-type", contentType);
  res.sendFile(target);
}));

app.get("/download/:id/html", asyncRoute(async (req, res) => {
  const metadata = await storage.readMetadata(req.params.id);
  const { target } = await storage.getContentFile(req.params.id, metadata.contentEntry);
  res.download(target, downloadName(metadata.title, "html"));
}));

app.get("/download/:id/zip", asyncRoute(async (req, res) => {
  const metadata = await storage.readMetadata(req.params.id);
  const zip = await storage.zipContent(req.params.id);
  res.setHeader("content-type", "application/zip");
  res.setHeader("content-disposition", `attachment; filename="${downloadName(metadata.title, "zip")}"`);
  res.send(zip);
}));

app.use((req, res) => {
  res.status(404).render("error", {
    title: "Not found",
    message: "That page does not exist."
  });
});

app.use((error, req, res, next) => {
  const message = error.message || "Something went wrong.";
  if (req.path === "/capture" || req.path === "/upload") {
    res.redirect(`/?error=${encodeURIComponent(message)}`);
    return;
  }
  res.status(500).render("error", {
    title: "Error",
    message
  });
});

storage.ensureStorage().then(() => {
  app.listen(config.port, () => {
    console.log(`${config.appName} running at http://localhost:${config.port}`);
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = app;
