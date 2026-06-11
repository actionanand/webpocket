const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const mime = require("mime-types");
const config = require("../config");

async function ensureStorage() {
  await fs.mkdir(config.pagesDir, { recursive: true });
  await fs.mkdir(config.tmpDir, { recursive: true });
}

function createId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function safeName(value, fallback = "saved-page") {
  return String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80)
    .toLowerCase() || fallback;
}

function pageDir(id) {
  const clean = path.basename(id);
  return path.join(config.pagesDir, clean);
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

async function createPage({ title, sourceUrl, kind, contentEntry = "index.html" }) {
  await ensureStorage();
  const id = createId();
  const dir = pageDir(id);
  const contentDir = path.join(dir, "content");
  await fs.mkdir(contentDir, { recursive: true });

  const metadata = {
    id,
    title: title || "Untitled page",
    sourceUrl: sourceUrl || "",
    kind: kind || "html",
    contentEntry,
    sizeBytes: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await writeMetadata(id, metadata);
  return { id, dir, contentDir, metadata };
}

async function writeMetadata(id, metadata) {
  const dir = pageDir(id);
  await fs.mkdir(dir, { recursive: true });
  const next = {
    ...metadata,
    sizeBytes: Number(metadata.sizeBytes || 0),
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(
    path.join(dir, "metadata.json"),
    JSON.stringify(next, null, 2)
  );
}

async function readMetadata(id) {
  const raw = await fs.readFile(path.join(pageDir(id), "metadata.json"), "utf8");
  return JSON.parse(raw);
}

async function listPages() {
  await ensureStorage();
  const entries = await fs.readdir(config.pagesDir, { withFileTypes: true });
  const pages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const metadata = await readMetadata(entry.name);
      pages.push(metadata.sizeBytes ? metadata : await updatePageSize(entry.name));
    } catch {
      // Ignore partial imports instead of breaking the whole library page.
    }
  }

  return pages.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function resolveInside(root, requested = "") {
  const normalized = requested.replace(/^[/\\]+/, "");
  const target = path.resolve(root, normalized);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Unsafe path");
  }
  return target;
}

async function writeContentFile(id, relativePath, data) {
  const contentDir = path.join(pageDir(id), "content");
  const target = resolveInside(contentDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}

async function getContentFile(id, relativePath) {
  const metadata = await readMetadata(id);
  const contentDir = path.join(pageDir(id), "content");
  const target = resolveInside(contentDir, relativePath || metadata.contentEntry);
  return { metadata, target, contentType: mime.lookup(target) || "application/octet-stream" };
}

async function pageExists(id) {
  try {
    await fs.access(path.join(pageDir(id), "metadata.json"));
    return true;
  } catch {
    return false;
  }
}

async function deletePage(id) {
  const dir = pageDir(id);
  await fs.rm(dir, { recursive: true, force: true });
}

async function directorySize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(abs);
    } else {
      total += (await fs.stat(abs)).size;
    }
  }
  return total;
}

async function updatePageSize(id) {
  const metadata = await readMetadata(id);
  const contentDir = path.join(pageDir(id), "content");
  metadata.sizeBytes = await directorySize(contentDir);
  await writeMetadata(id, metadata);
  return metadata;
}

async function zipContent(id) {
  const metadata = await readMetadata(id);
  const contentDir = path.join(pageDir(id), "content");
  const zip = new AdmZip();

  async function addDir(dir, prefix = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) {
        await addDir(abs, rel);
      } else {
        zip.addFile(rel, await fs.readFile(abs));
      }
    }
  }

  await addDir(contentDir);
  zip.addFile("webpocket-metadata.json", Buffer.from(JSON.stringify(metadata, null, 2)));
  return zip.toBuffer();
}

module.exports = {
  ensureStorage,
  safeName,
  formatBytes,
  createPage,
  writeMetadata,
  readMetadata,
  listPages,
  pageDir,
  pageExists,
  deletePage,
  updatePageSize,
  resolveInside,
  writeContentFile,
  getContentFile,
  zipContent
};
