const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns/promises");
const net = require("net");
const AdmZip = require("adm-zip");
const config = require("../config");
const storage = require("./storage");
const {
  absoluteUrl,
  findAssetUrls,
  optimizeSingleHtml,
  rewriteForLocalAssets
} = require("./htmlOptimizer");

function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs can be saved.");
  }

  return parsed;
}

function isPrivateIp(address) {
  if (!net.isIP(address)) return false;
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return true;
  if (address.startsWith("169.254.")) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(address)) return true;
  if (/^fe80:/i.test(address)) return true;
  return false;
}

async function validateReachablePublicUrl(rawUrl) {
  const parsed = assertPublicHttpUrl(rawUrl);
  const records = await dns.lookup(parsed.hostname, { all: true });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw new Error("That URL resolves to a private network address and was blocked.");
  }
  return parsed.toString();
}

async function readResponseWithLimit(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength > maxBytes) {
    throw new Error(`Response is too large (${contentLength} bytes).`);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error("Response is too large.");
    return buffer;
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) throw new Error("Response is too large.");
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function fetchWithLimit(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "webpocket/0.1 offline reader",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!response.ok) throw new Error(`Request failed with status ${response.status}.`);
    return {
      finalUrl: response.url,
      contentType: response.headers.get("content-type") || "",
      buffer: await readResponseWithLimit(response, maxBytes)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url) {
  const publicUrl = await validateReachablePublicUrl(url);
  const response = await fetchWithLimit(publicUrl, config.limits.maxHtmlBytes);
  if (!response.contentType.includes("text/html") && !response.contentType.includes("application/xhtml")) {
    throw new Error("The URL did not return an HTML page.");
  }
  return {
    finalUrl: response.finalUrl,
    html: response.buffer.toString("utf8")
  };
}

function assetPathForUrl(url) {
  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname).split("?")[0] || ".bin";
  const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
  const name = path.basename(parsed.pathname).replace(/[^\w.\-]+/g, "-") || `asset${ext}`;
  return `assets/${hash}-${name}`;
}

async function captureOptimizedHtml(url) {
  const { finalUrl, html } = await fetchHtml(url);
  return optimizeSingleHtml(html, { baseUrl: finalUrl, titleFallback: finalUrl });
}

async function saveOptimizedPage(url) {
  const { finalUrl, html } = await fetchHtml(url);
  const optimized = optimizeSingleHtml(html, { baseUrl: finalUrl, titleFallback: finalUrl });
  const page = await storage.createPage({
    title: optimized.title,
    sourceUrl: finalUrl,
    kind: "optimized-html"
  });
  await storage.writeContentFile(page.id, "index.html", optimized.html);
  return page.metadata;
}

async function captureZipBuffer(url) {
  const { finalUrl, html } = await fetchHtml(url);
  const assetUrls = findAssetUrls(html, finalUrl).slice(0, config.limits.maxAssetsPerPage);
  const assetMap = new Map();
  const zip = new AdmZip();
  let totalBytes = 0;

  for (const assetUrl of assetUrls) {
    try {
      await validateReachablePublicUrl(assetUrl);
      const response = await fetchWithLimit(assetUrl, config.limits.maxAssetBytes);
      totalBytes += response.buffer.length;
      if (totalBytes > config.limits.maxTotalAssetBytes) break;
      const localPath = assetPathForUrl(assetUrl);
      assetMap.set(assetUrl, localPath);
      zip.addFile(localPath, response.buffer);
    } catch {
      // Missing assets should not prevent the reader copy from being created.
    }
  }

  const rewritten = rewriteForLocalAssets(html, {
    baseUrl: finalUrl,
    assetMap,
    titleFallback: finalUrl
  });
  zip.addFile("index.html", Buffer.from(rewritten.html));
  zip.addFile(
    "webpocket-metadata.json",
    Buffer.from(JSON.stringify({
      title: rewritten.title,
      sourceUrl: finalUrl,
      createdAt: new Date().toISOString(),
      assetCount: assetMap.size
    }, null, 2))
  );
  return {
    title: rewritten.title,
    buffer: zip.toBuffer()
  };
}

async function saveZipCapture(url) {
  const { finalUrl, html } = await fetchHtml(url);
  const page = await storage.createPage({
    title: finalUrl,
    sourceUrl: finalUrl,
    kind: "html-with-assets"
  });
  const assetUrls = findAssetUrls(html, finalUrl).slice(0, config.limits.maxAssetsPerPage);
  const assetMap = new Map();
  let totalBytes = 0;

  for (const assetUrl of assetUrls) {
    try {
      await validateReachablePublicUrl(assetUrl);
      const response = await fetchWithLimit(assetUrl, config.limits.maxAssetBytes);
      totalBytes += response.buffer.length;
      if (totalBytes > config.limits.maxTotalAssetBytes) break;
      const localPath = assetPathForUrl(assetUrl);
      assetMap.set(assetUrl, localPath);
      await storage.writeContentFile(page.id, localPath, response.buffer);
    } catch {
      // Keep the page readable even when a secondary asset fails.
    }
  }

  const rewritten = rewriteForLocalAssets(html, {
    baseUrl: finalUrl,
    assetMap,
    titleFallback: finalUrl
  });
  page.metadata.title = rewritten.title;
  page.metadata.sourceUrl = finalUrl;
  await storage.writeContentFile(page.id, "index.html", rewritten.html);
  await storage.writeMetadata(page.id, page.metadata);
  return page.metadata;
}

async function importUploadedFiles(files) {
  if (!files || !files.length) throw new Error("Choose an HTML file, ZIP, or folder to import.");
  const zipFile = files.find((file) => /\.zip$/i.test(file.originalname));
  if (zipFile && files.length === 1) return importZip(zipFile.path);
  return importHtmlFiles(files);
}

function zipEntryIsSafe(entryName) {
  return entryName && !entryName.includes("..") && !path.isAbsolute(entryName);
}

async function importZip(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory && zipEntryIsSafe(entry.entryName));
  const htmlEntry =
    entries.find((entry) => /(^|\/)index\.html?$/i.test(entry.entryName)) ||
    entries.find((entry) => /\.html?$/i.test(entry.entryName));

  if (!htmlEntry) throw new Error("The ZIP does not contain an HTML file.");

  const page = await storage.createPage({
    title: path.basename(htmlEntry.entryName),
    kind: "imported-zip",
    contentEntry: htmlEntry.entryName.replace(/\\/g, "/")
  });

  for (const entry of entries) {
    await storage.writeContentFile(page.id, entry.entryName, entry.getData());
  }

  const html = htmlEntry.getData().toString("utf8");
  const optimized = optimizeSingleHtml(html, { titleFallback: path.basename(htmlEntry.entryName) });
  page.metadata.title = optimized.title;
  await storage.writeMetadata(page.id, page.metadata);
  return page.metadata;
}

async function importHtmlFiles(files) {
  const htmlFile =
    files.find((file) => /\.html?$/i.test(file.originalname)) ||
    files.find((file) => /text\/html/i.test(file.mimetype || ""));

  if (!htmlFile) throw new Error("No HTML file was found in the upload.");

  const page = await storage.createPage({
    title: path.basename(htmlFile.originalname),
    kind: files.length > 1 ? "imported-folder" : "imported-html",
    contentEntry: normalizeUploadPath(htmlFile.originalname)
  });

  for (const file of files) {
    const relativePath = normalizeUploadPath(file.originalname);
    await storage.writeContentFile(page.id, relativePath, await fs.readFile(file.path));
  }

  const html = await fs.readFile(htmlFile.path, "utf8");
  const optimized = optimizeSingleHtml(html, { titleFallback: path.basename(htmlFile.originalname) });
  page.metadata.title = optimized.title;
  await storage.writeMetadata(page.id, page.metadata);
  return page.metadata;
}

function normalizeUploadPath(originalName) {
  return String(originalName || "index.html")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/") || "index.html";
}

module.exports = {
  captureOptimizedHtml,
  captureZipBuffer,
  importUploadedFiles,
  saveOptimizedPage,
  saveZipCapture
};
