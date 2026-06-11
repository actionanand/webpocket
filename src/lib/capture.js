const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const dns = require("dns/promises");
const net = require("net");
const AdmZip = require("adm-zip");
const cheerio = require("cheerio");
const mime = require("mime-types");
const config = require("../config");
const storage = require("./storage");
const {
  absoluteUrl,
  findAssetUrls,
  optimizeSingleHtml,
  readableTitle,
  rewriteForLocalAssetsFull
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

function parseJsonObject(value, label) {
  if (!String(value || "").trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function normalizeHeaderName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return "";
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized)) {
    throw new Error(`Invalid header name: ${name}`);
  }
  return normalized;
}

function stringifyHeaderValue(value) {
  if (typeof value === "string") return value;
  if (value === null || typeof value === "undefined") return "";
  return JSON.stringify(value);
}


function headerValueFromTemplate(value, localStorageEntries) {
  const stringValue = stringifyHeaderValue(value);
  return stringValue.replace(/\{\{\s*(?:localStorage\.)?([\w.-]+)\s*\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(localStorageEntries, key) ? localStorageEntries[key] : "";
  });
}

function normalizeCookieHeader(cookies) {
  const raw = String(cookies || "").trim();
  if (!raw) return "";
  if (/\r|\n/.test(raw)) throw new Error("Cookie header cannot contain line breaks.");
  return raw;
}

function localStorageEntriesFromJson(rawJson) {
  const parsed = parseJsonObject(rawJson, "Local storage JSON");
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [
    String(key),
    typeof value === "string" ? value : JSON.stringify(value)
  ]));
}

function findTokenInLocalStorage(localStorageEntries) {
  const tokenKeyPattern = /(^|[_-])(access[_-]?token|auth[_-]?token|id[_-]?token|jwt|token)([_-]|$)/i;
  for (const [key, value] of Object.entries(localStorageEntries)) {
    if (tokenKeyPattern.test(key) && String(value || "").trim()) return String(value).trim();
  }
  return "";
}

function buildCaptureOptions(input = {}) {
  const localStorageEntries = localStorageEntriesFromJson(input.localStorageJson || "");
  const customHeaders = parseJsonObject(input.headersJson || "", "Request headers JSON");
  const headers = {};

  for (const [name, value] of Object.entries(customHeaders)) {
    const normalized = normalizeHeaderName(name);
    if (!normalized) continue;
    if (["host", "connection", "content-length", "transfer-encoding"].includes(normalized)) continue;
    headers[normalized] = headerValueFromTemplate(value, localStorageEntries);
  }

  const token = String(input.bearerToken || "").trim() || findTokenInLocalStorage(localStorageEntries);
  if (token && !headers.authorization) {
    headers.authorization = /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  }

  const cookie = normalizeCookieHeader(input.cookies || "");
  if (cookie && !headers.cookie) headers.cookie = cookie;

  return {
    headers,
    localStorageEntries,
    sendAuthToAllHosts: input.sendAuthToAllHosts === true || input.sendAuthToAllHosts === "on"
  };
}

function headersForRequest(authOptions = {}, requestUrl, firstPartyOrigin = "") {
  const headers = { ...(authOptions.headers || {}) };
  if (!Object.keys(headers).length) return headers;
  if (authOptions.sendAuthToAllHosts) return headers;

  let requestOrigin = "";
  try {
    requestOrigin = new URL(requestUrl).origin;
  } catch {
    return {};
  }
  return !firstPartyOrigin || requestOrigin === firstPartyOrigin ? headers : {};
}

async function fetchWithLimit(url, maxBytes, authOptions = {}, firstPartyOrigin = "") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "webpocket/0.1 offline reader",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...headersForRequest(authOptions, url, firstPartyOrigin)
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

function bufferToDataUri(buffer, contentType = "") {
  const type = contentType.split(";")[0].trim() || "application/octet-stream";
  return `data:${type};base64,${buffer.toString("base64")}`;
}

function cssUrlRegex() {
  return /url\(\s*(['"]?)(?!data:|#|about:|blob:)([^'")]+)\1\s*\)/gi;
}

async function inlineCssAssets(css, cssBaseUrl, fetchAssetAsDataUri) {
  const replacements = [];
  let match;
  const regex = cssUrlRegex();

  while ((match = regex.exec(css)) !== null) {
    const raw = match[2].trim();
    const abs = absoluteUrl(raw, cssBaseUrl);
    if (!abs || !/^https?:\/\//i.test(abs)) continue;
    replacements.push({ original: match[0], abs });
  }

  let next = css;
  for (const replacement of replacements) {
    try {
      const dataUri = await fetchAssetAsDataUri(replacement.abs);
      next = next.split(replacement.original).join(`url("${dataUri}")`);
    } catch {
      next = next.split(replacement.original).join(`url("${replacement.abs}")`);
    }
  }
  return next;
}

async function fetchHtml(url, authOptions = {}) {
  const publicUrl = await validateReachablePublicUrl(url);
  const response = await fetchWithLimit(publicUrl, config.limits.maxHtmlBytes, authOptions, new URL(publicUrl).origin);
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

async function collectLocalAssets(html, finalUrl, writeAsset, authOptions = {}) {
  const initialAssetUrls = findAssetUrls(html, finalUrl, { full: true })
    .slice(0, config.limits.maxAssetsPerPage);
  const assetMap = new Map();
  let totalBytes = 0;

  async function ensureAsset(assetUrl) {
    if (assetMap.has(assetUrl)) return assetMap.get(assetUrl);
    if (assetMap.size >= config.limits.maxAssetsPerPage) return assetUrl;

    const localPath = assetPathForUrl(assetUrl);
    assetMap.set(assetUrl, localPath);

    try {
      await validateReachablePublicUrl(assetUrl);
      const response = await fetchWithLimit(assetUrl, config.limits.maxAssetBytes, authOptions, new URL(finalUrl).origin);
      totalBytes += response.buffer.length;
      if (totalBytes > config.limits.maxTotalAssetBytes) {
        throw new Error("Asset budget reached.");
      }

      let buffer = response.buffer;
      if (isCssAsset(response.contentType, assetUrl)) {
        const css = await rewriteCssForLocalAssets(
          response.buffer.toString("utf8"),
          response.finalUrl || assetUrl,
          localPath,
          ensureAsset
        );
        buffer = Buffer.from(css);
      }

      await writeAsset(localPath, buffer);
      return localPath;
    } catch (error) {
      assetMap.delete(assetUrl);
      throw error;
    }
  }

  for (const assetUrl of initialAssetUrls) {
    try {
      await ensureAsset(assetUrl);
    } catch {
      assetMap.delete(assetUrl);
    }
  }

  return assetMap;
}

function isCssAsset(contentType, assetUrl) {
  return contentType.includes("text/css") || /\.css(?:[?#].*)?$/i.test(assetUrl);
}

async function rewriteCssForLocalAssets(css, cssBaseUrl, cssLocalPath, ensureAsset) {
  const replacements = [];
  let match;
  const regex = cssUrlRegex();

  while ((match = regex.exec(css)) !== null) {
    const raw = match[2].trim();
    const abs = absoluteUrl(raw, cssBaseUrl);
    if (!abs || !/^https?:\/\//i.test(abs)) continue;
    replacements.push({ original: match[0], abs });
  }

  let next = css;
  for (const replacement of replacements) {
    try {
      const nestedLocalPath = await ensureAsset(replacement.abs);
      const relativePath = path.posix.relative(
        path.posix.dirname(cssLocalPath),
        nestedLocalPath
      ) || path.posix.basename(nestedLocalPath);
      next = next.split(replacement.original).join(`url("${relativePath}")`);
    } catch {
      next = next.split(replacement.original).join(`url("${replacement.abs}")`);
    }
  }
  return next;
}

async function captureOptimizedHtml(url, authOptions = {}) {
  const { finalUrl, html } = await fetchHtml(url, authOptions);
  return optimizeSingleHtml(html, { baseUrl: finalUrl, titleFallback: finalUrl });
}

async function captureSinglePageHtml(url, authOptions = {}) {
  const { finalUrl, html } = await fetchHtml(url, authOptions);
  return buildSinglePageHtml(html, finalUrl, authOptions);
}

async function saveSinglePage(url, authOptions = {}) {
  const { finalUrl, html } = await fetchHtml(url, authOptions);
  const singlePage = await buildSinglePageHtml(html, finalUrl, authOptions);
  const page = await storage.createPage({
    title: singlePage.title,
    sourceUrl: finalUrl,
    kind: "single-html"
  });
  await storage.writeContentFile(page.id, "index.html", singlePage.html);
  return storage.updatePageSize(page.id);
}

async function buildSinglePageHtml(html, finalUrl, authOptions = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const title = readableTitle($, finalUrl);
  const dataUriCache = new Map();
  let totalBytes = 0;

  async function fetchAssetAsDataUri(assetUrl) {
    if (dataUriCache.has(assetUrl)) return dataUriCache.get(assetUrl);
    await validateReachablePublicUrl(assetUrl);
    const response = await fetchWithLimit(assetUrl, config.limits.maxAssetBytes, authOptions, new URL(finalUrl).origin);
    totalBytes += response.buffer.length;
    if (totalBytes > config.limits.maxTotalAssetBytes) {
      throw new Error("Asset budget reached.");
    }
    const dataUri = bufferToDataUri(response.buffer, response.contentType);
    dataUriCache.set(assetUrl, dataUri);
    return dataUri;
  }

  $("base").remove();
  $("script").remove();
  $("meta[http-equiv]").each((_, node) => {
    const value = String($(node).attr("http-equiv") || "").toLowerCase();
    if (value === "refresh" || value === "content-security-policy") {
      $(node).remove();
    }
  });
  $("meta[charset]").remove();
  $("head").prepend("<meta charset=\"utf-8\">");
  if (!$("meta[name='viewport']").length) {
    $("head").append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
  }
  $("head").append(`<meta name="generator" content="webpocket single-html">`);

  $("[href]").each((_, node) => {
    const el = $(node);
    const value = el.attr("href");
    if (!value || value.startsWith("#")) return;
    const abs = absoluteUrl(value, finalUrl);
    if (abs) el.attr("href", abs);
  });

  const styleNodes = $("style").toArray();
  for (const node of styleNodes) {
    const el = $(node);
    el.text(await inlineCssAssets(el.html() || "", finalUrl, fetchAssetAsDataUri));
  }

  const stylesheetLinks = $("link[rel~='stylesheet'][href]").toArray();
  for (const node of stylesheetLinks) {
    const el = $(node);
    const href = absoluteUrl(el.attr("href"), finalUrl);
    if (!href) continue;
    try {
      const response = await fetchWithLimit(href, config.limits.maxAssetBytes, authOptions, new URL(finalUrl).origin);
      const css = await inlineCssAssets(response.buffer.toString("utf8"), response.finalUrl || href, fetchAssetAsDataUri);
      el.replaceWith(`<style data-webpocket-source="${escapeHtml(href)}">\n${css}\n</style>`);
    } catch {
      el.attr("href", href);
    }
  }

  await inlineAttributeAssets($, "img", "src", finalUrl, fetchAssetAsDataUri);
  await inlineAttributeAssets($, "source", "src", finalUrl, fetchAssetAsDataUri);
  await inlineAttributeAssets($, "video", "poster", finalUrl, fetchAssetAsDataUri);
  await inlineAttributeAssets($, "link[rel~='icon']", "href", finalUrl, fetchAssetAsDataUri);
  await inlineAttributeAssets($, "link[rel='apple-touch-icon']", "href", finalUrl, fetchAssetAsDataUri);
  await inlineSrcsetAssets($, "img", finalUrl, fetchAssetAsDataUri);
  await inlineSrcsetAssets($, "source", finalUrl, fetchAssetAsDataUri);

  return {
    title,
    html: $.html()
  };
}

async function inlineAttributeAssets($, selector, attr, baseUrl, fetchAssetAsDataUri) {
  const nodes = $(`${selector}[${attr}]`).toArray();
  for (const node of nodes) {
    const el = $(node);
    const abs = absoluteUrl(el.attr(attr), baseUrl);
    if (!abs || !/^https?:\/\//i.test(abs)) continue;
    try {
      el.attr(attr, await fetchAssetAsDataUri(abs));
    } catch {
      el.attr(attr, abs);
      el.attr("data-webpocket-missing-asset", "true");
    }
  }
}

async function inlineSrcsetAssets($, selector, baseUrl, fetchAssetAsDataUri) {
  const nodes = $(`${selector}[srcset]`).toArray();
  for (const node of nodes) {
    const el = $(node);
    const srcset = el.attr("srcset");
    const candidates = String(srcset || "")
      .split(",")
      .map((candidate) => candidate.trim())
      .filter(Boolean);
    const next = [];

    for (const candidate of candidates) {
      const parts = candidate.split(/\s+/);
      const abs = absoluteUrl(parts[0], baseUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) {
        next.push(candidate);
        continue;
      }
      try {
        next.push([await fetchAssetAsDataUri(abs), ...parts.slice(1)].join(" "));
      } catch {
        next.push([abs, ...parts.slice(1)].join(" "));
      }
    }
    if (next.length) el.attr("srcset", next.join(", "));
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function saveOptimizedPage(url, authOptions = {}) {
  const { finalUrl, html } = await fetchHtml(url, authOptions);
  const optimized = optimizeSingleHtml(html, { baseUrl: finalUrl, titleFallback: finalUrl });
  const page = await storage.createPage({
    title: optimized.title,
    sourceUrl: finalUrl,
    kind: "optimized-html"
  });
  await storage.writeContentFile(page.id, "index.html", optimized.html);
  return storage.updatePageSize(page.id);
}

async function captureZipBuffer(url, authOptions = {}) {
  const { finalUrl, html } = await fetchHtml(url, authOptions);
  const zip = new AdmZip();
  const assetMap = await collectLocalAssets(html, finalUrl, async (localPath, buffer) => {
    zip.addFile(localPath, buffer);
  }, authOptions);

  const rewritten = rewriteForLocalAssetsFull(html, {
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

async function saveZipCapture(url, authOptions = {}) {
  const { finalUrl, html } = await fetchHtml(url, authOptions);
  const page = await storage.createPage({
    title: finalUrl,
    sourceUrl: finalUrl,
    kind: "html-with-assets"
  });
  const assetMap = await collectLocalAssets(html, finalUrl, async (localPath, buffer) => {
    await storage.writeContentFile(page.id, localPath, buffer);
  }, authOptions);

  const rewritten = rewriteForLocalAssetsFull(html, {
    baseUrl: finalUrl,
    assetMap,
    titleFallback: finalUrl
  });
  page.metadata.title = rewritten.title;
  page.metadata.sourceUrl = finalUrl;
  await storage.writeContentFile(page.id, "index.html", rewritten.html);
  await storage.writeMetadata(page.id, page.metadata);
  return storage.updatePageSize(page.id);
}

async function importUploadedFiles(files, { mode = "preserve-assets" } = {}) {
  if (!files || !files.length) throw new Error("Choose an HTML file, ZIP, or folder to import.");
  const zipFile = files.find((file) => /\.zip$/i.test(file.originalname));
  if (zipFile && files.length === 1) return importZip(zipFile.path, { mode });
  return importHtmlFiles(files, { mode });
}

function zipEntryIsSafe(entryName) {
  return entryName && !entryName.includes("..") && !path.isAbsolute(entryName);
}

async function importZip(zipPath, { mode = "preserve-assets" } = {}) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory && zipEntryIsSafe(entry.entryName));
  const htmlEntry =
    entries.find((entry) => /(^|\/)index\.html?$/i.test(entry.entryName)) ||
    entries.find((entry) => /\.html?$/i.test(entry.entryName));

  if (!htmlEntry) throw new Error("The ZIP does not contain an HTML file.");

  const records = entries.map((entry) => ({
    relativePath: normalizeUploadPath(entry.entryName),
    buffer: entry.getData()
  }));
  const htmlRecord = records.find((record) => record.relativePath === normalizeUploadPath(htmlEntry.entryName));

  if (mode === "single-html") {
    return importRecordsAsSingleHtml(records, htmlRecord);
  }

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
  return storage.updatePageSize(page.id);
}

async function importHtmlFiles(files, { mode = "preserve-assets" } = {}) {
  const records = await Promise.all(files.map(async (file) => ({
    relativePath: normalizeUploadPath(file.originalname),
    mimetype: file.mimetype || "",
    buffer: await fs.readFile(file.path)
  })));

  const htmlRecord =
    records.find((record) => /\.html?$/i.test(record.relativePath)) ||
    records.find((record) => /text\/html/i.test(record.mimetype || ""));

  if (!htmlRecord) throw new Error("No HTML file was found in the upload.");

  if (mode === "single-html") {
    return importRecordsAsSingleHtml(records, htmlRecord);
  }

  const page = await storage.createPage({
    title: path.basename(htmlRecord.relativePath),
    kind: files.length > 1 ? "imported-folder" : "imported-html",
    contentEntry: htmlRecord.relativePath
  });

  for (const record of records) {
    await storage.writeContentFile(page.id, record.relativePath, record.buffer);
  }

  const html = htmlRecord.buffer.toString("utf8");
  const optimized = optimizeSingleHtml(html, { titleFallback: path.basename(htmlRecord.relativePath) });
  page.metadata.title = optimized.title;
  await storage.writeMetadata(page.id, page.metadata);
  return storage.updatePageSize(page.id);
}

async function importRecordsAsSingleHtml(records, htmlRecord) {
  const html = htmlRecord.buffer.toString("utf8");
  const converted = await buildSinglePageFromLocalPackage(html, htmlRecord.relativePath, records);
  const page = await storage.createPage({
    title: converted.title,
    kind: "imported-single-html",
    contentEntry: "index.html"
  });
  await storage.writeContentFile(page.id, "index.html", converted.html);
  return storage.updatePageSize(page.id);
}

async function buildSinglePageFromLocalPackage(html, htmlEntryPath, records) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const title = readableTitle($, path.basename(htmlEntryPath));
  const recordMap = new Map(records.map((record) => [normalizeUploadPath(record.relativePath), record]));

  const getRecord = (resource, baseEntryPath) => {
    const resolved = resolveLocalResourcePath(resource, baseEntryPath);
    if (!resolved) return null;
    return recordMap.get(resolved) || recordMap.get(decodePath(resolved)) || null;
  };

  const recordToDataUri = (record) => {
    const type = record.mimetype || mime.lookup(record.relativePath) || "application/octet-stream";
    return bufferToDataUri(record.buffer, type);
  };

  const inlineLocalCss = async (css, cssEntryPath) => {
    const replacements = [];
    let match;
    const regex = cssUrlRegex();
    while ((match = regex.exec(css)) !== null) {
      const record = getRecord(match[2].trim(), cssEntryPath);
      if (record) replacements.push({ original: match[0], dataUri: recordToDataUri(record) });
    }

    let next = css;
    for (const replacement of replacements) {
      next = next.split(replacement.original).join(`url("${replacement.dataUri}")`);
    }
    return next;
  };

  $("base").remove();
  $("script").remove();
  $("meta[http-equiv]").each((_, node) => {
    const value = String($(node).attr("http-equiv") || "").toLowerCase();
    if (value === "refresh" || value === "content-security-policy") $(node).remove();
  });
  $("meta[charset]").remove();
  $("head").prepend("<meta charset=\"utf-8\">");
  if (!$("meta[name='viewport']").length) {
    $("head").append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
  }
  $("head").append("<meta name=\"generator\" content=\"webpocket imported-single-html\">");

  const styleNodes = $("style").toArray();
  for (const node of styleNodes) {
    const el = $(node);
    el.text(await inlineLocalCss(el.html() || "", htmlEntryPath));
  }

  const stylesheetLinks = $("link[rel~='stylesheet'][href]").toArray();
  for (const node of stylesheetLinks) {
    const el = $(node);
    const record = getRecord(el.attr("href"), htmlEntryPath);
    if (!record) continue;
    const css = await inlineLocalCss(record.buffer.toString("utf8"), record.relativePath);
    el.replaceWith(`<style data-webpocket-source="${escapeHtml(record.relativePath)}">\n${css}\n</style>`);
  }

  inlineLocalAttribute($, "img", "src", htmlEntryPath, getRecord, recordToDataUri);
  inlineLocalAttribute($, "source", "src", htmlEntryPath, getRecord, recordToDataUri);
  inlineLocalAttribute($, "video", "poster", htmlEntryPath, getRecord, recordToDataUri);
  inlineLocalAttribute($, "link[rel~='icon']", "href", htmlEntryPath, getRecord, recordToDataUri);
  inlineLocalAttribute($, "link[rel='apple-touch-icon']", "href", htmlEntryPath, getRecord, recordToDataUri);
  inlineLocalSrcset($, "img", htmlEntryPath, getRecord, recordToDataUri);
  inlineLocalSrcset($, "source", htmlEntryPath, getRecord, recordToDataUri);

  return {
    title,
    html: $.html()
  };
}

function inlineLocalAttribute($, selector, attr, htmlEntryPath, getRecord, recordToDataUri) {
  $(`${selector}[${attr}]`).each((_, node) => {
    const el = $(node);
    const record = getRecord(el.attr(attr), htmlEntryPath);
    if (record) el.attr(attr, recordToDataUri(record));
  });
}

function inlineLocalSrcset($, selector, htmlEntryPath, getRecord, recordToDataUri) {
  $(`${selector}[srcset]`).each((_, node) => {
    const el = $(node);
    const candidates = String(el.attr("srcset") || "")
      .split(",")
      .map((candidate) => candidate.trim())
      .filter(Boolean);
    const next = candidates.map((candidate) => {
      const parts = candidate.split(/\s+/);
      const record = getRecord(parts[0], htmlEntryPath);
      return record ? [recordToDataUri(record), ...parts.slice(1)].join(" ") : candidate;
    });
    if (next.length) el.attr("srcset", next.join(", "));
  });
}

function resolveLocalResourcePath(resource, baseEntryPath) {
  if (!resource || /^(?:https?:|data:|mailto:|tel:|blob:|#)/i.test(resource)) return "";
  const clean = decodePath(String(resource).split("#")[0].split("?")[0]);
  const baseDir = path.posix.dirname(normalizeUploadPath(baseEntryPath));
  return normalizeUploadPath(path.posix.join(baseDir, clean));
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  buildCaptureOptions,
  captureOptimizedHtml,
  captureSinglePageHtml,
  captureZipBuffer,
  importUploadedFiles,
  saveOptimizedPage,
  saveSinglePage,
  saveZipCapture
};
