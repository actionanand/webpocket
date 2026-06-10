const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const storageRoot = path.resolve(
  rootDir,
  process.env.WEBPOCKET_STORAGE || "storage"
);

module.exports = {
  appName: "webpocket",
  port: Number(process.env.PORT || 3000),
  rootDir,
  publicDir: path.join(rootDir, "public"),
  viewsDir: path.join(rootDir, "views"),
  storageRoot,
  pagesDir: path.join(storageRoot, "pages"),
  tmpDir: path.join(storageRoot, "tmp"),
  limits: {
    maxHtmlBytes: Number(process.env.WEBPOCKET_MAX_HTML_BYTES || 3_000_000),
    maxAssetBytes: Number(process.env.WEBPOCKET_MAX_ASSET_BYTES || 1_500_000),
    maxTotalAssetBytes: Number(
      process.env.WEBPOCKET_MAX_TOTAL_ASSET_BYTES || 12_000_000
    ),
    maxUploadedBytes: Number(process.env.WEBPOCKET_MAX_UPLOAD_BYTES || 40_000_000),
    maxAssetsPerPage: Number(process.env.WEBPOCKET_MAX_ASSETS_PER_PAGE || 80)
  }
};
