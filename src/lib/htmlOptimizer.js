const cheerio = require("cheerio");

function readableTitle($, fallback = "Saved page") {
  return (
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    fallback
  ).slice(0, 140);
}

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return "";
  }
}

function removeHeavyAndTrackingNodes($) {
  $(
    [
      "script",
      "noscript",
      "iframe",
      "frame",
      "object",
      "embed",
      "video",
      "audio",
      "source",
      "track",
      "canvas",
      "form",
      "input",
      "button",
      "select",
      "textarea",
      "svg script",
      "link[rel='preload']",
      "link[rel='preconnect']",
      "link[rel='dns-prefetch']",
      "link[rel='modulepreload']"
    ].join(",")
  ).remove();
}

function removeOfflineBreakingMeta($) {
  $("meta[http-equiv]").each((_, node) => {
    const value = String($(node).attr("http-equiv") || "").toLowerCase();
    if (value === "refresh" || value === "content-security-policy") {
      $(node).remove();
    }
  });
}

function removeAdAndSponsoredBlocks($) {
  const adPattern = /(^|[-_\s])(ad|ads|advert|advertisement|sponsor|sponsored|promoted|promo|outbrain|taboola|doubleclick|googlesyndication|adservice|adunit|ad-container|ad-wrapper)([-_\s]|$)/i;

  $("[id], [class], [aria-label], [data-ad], [data-testid], [role='complementary']").each((_, node) => {
    const el = $(node);
    const haystack = [
      el.attr("id"),
      el.attr("class"),
      el.attr("aria-label"),
      el.attr("data-testid"),
      el.attr("data-ad")
    ].filter(Boolean).join(" ");

    if (adPattern.test(haystack)) {
      el.remove();
    }
  });

  $("iframe[src], img[src], a[href]").each((_, node) => {
    const el = $(node);
    const source = el.attr("src") || el.attr("href") || "";
    if (/doubleclick|googlesyndication|googleadservices|adservice|taboola|outbrain|adnxs|adsystem|advertising/i.test(source)) {
      el.remove();
    }
  });
}

function rewriteLinks($, baseUrl) {
  $("[href]").each((_, node) => {
    const el = $(node);
    const value = el.attr("href");
    if (!value || value.startsWith("#")) return;
    const next = absoluteUrl(value, baseUrl);
    if (next) el.attr("href", next);
  });
}

function replaceImagesWithText($, baseUrl) {
  $("img").each((_, node) => {
    const el = $(node);
    const alt = el.attr("alt") || "Image removed for low-data offline reading";
    const src = absoluteUrl(el.attr("src"), baseUrl);
    const replacement = $("<figure class=\"wp-image-note\"></figure>");
    replacement.append($("<figcaption></figcaption>").text(alt));
    if (src) {
      replacement.append(
        $("<a class=\"wp-source-link\" target=\"_blank\" rel=\"noopener\"></a>")
          .attr("href", src)
          .text("Image source")
      );
    }
    el.replaceWith(replacement);
  });
}

function injectReaderStyles($, sourceUrl, mode) {
  $("meta[charset]").remove();
  $("head").prepend("<meta charset=\"utf-8\">");
  $("head").append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
  $("head").append(`<style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0 auto;
      max-width: 760px;
      padding: 18px;
      color: #172126;
      background: #fafaf7;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.62;
    }
    img, video, iframe { max-width: 100%; height: auto; }
    a { color: #006d77; overflow-wrap: anywhere; }
    pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
    table { max-width: 100%; display: block; overflow-x: auto; }
    .webpocket-note {
      margin: 0 0 18px;
      padding: 12px 14px;
      border: 1px solid #d7e2df;
      border-left: 4px solid #006d77;
      background: #ffffff;
      border-radius: 8px;
      color: #3b4a50;
      font-size: 0.92rem;
    }
    .wp-image-note {
      margin: 16px 0;
      padding: 12px;
      border: 1px dashed #b7c8c5;
      border-radius: 8px;
      background: #ffffff;
      color: #526164;
    }
    .wp-source-link { display: inline-block; margin-top: 6px; font-size: 0.9rem; }
  </style>`);

  const note = [
    "Saved by webpocket",
    mode === "minimal" ? "optimized for low data" : "with local assets",
    sourceUrl ? `from ${sourceUrl}` : ""
  ].filter(Boolean).join(" - ");
  $("body").prepend($("<aside class=\"webpocket-note\"></aside>").text(note));
}

function optimizeSingleHtml(html, { baseUrl = "", titleFallback = "Saved page" } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const title = readableTitle($, titleFallback);

  removeOfflineBreakingMeta($);
  removeHeavyAndTrackingNodes($);
  removeAdAndSponsoredBlocks($);
  rewriteLinks($, baseUrl);
  replaceImagesWithText($, baseUrl);
  $("link[rel='stylesheet']").remove();
  injectReaderStyles($, baseUrl, "minimal");

  return {
    title,
    html: $.html()
  };
}

function rewriteForLocalAssets(html, { baseUrl = "", assetMap = new Map(), titleFallback = "Saved page" } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const title = readableTitle($, titleFallback);

  removeOfflineBreakingMeta($);
  removeHeavyAndTrackingNodes($);
  rewriteLinks($, baseUrl);

  const rewriteAttr = (selector, attr) => {
    $(selector).each((_, node) => {
      const el = $(node);
      const original = el.attr(attr);
      const abs = absoluteUrl(original, baseUrl);
      if (abs && assetMap.has(abs)) {
        el.attr(attr, assetMap.get(abs));
      } else if (selector === "img") {
        const alt = el.attr("alt") || "Image unavailable offline";
        el.replaceWith($("<figure class=\"wp-image-note\"></figure>").text(alt));
      } else if (abs) {
        el.attr(attr, abs);
      }
    });
  };

  rewriteAttr("img", "src");
  rewriteAttr("link[rel='stylesheet']", "href");
  rewriteAttr("link[rel~='icon']", "href");
  injectReaderStyles($, baseUrl, "asset");

  return {
    title,
    html: $.html()
  };
}

function rewriteForLocalAssetsFull(html, { baseUrl = "", assetMap = new Map(), titleFallback = "Saved page" } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const title = readableTitle($, titleFallback);

  removeOfflineBreakingMeta($);
  $("base").remove();
  $("script").remove();
  rewriteLinks($, baseUrl);

  const rewriteAttr = (selector, attr) => {
    $(selector).each((_, node) => {
      const el = $(node);
      const original = el.attr(attr);
      const abs = absoluteUrl(original, baseUrl);
      if (abs && assetMap.has(abs)) {
        el.attr(attr, assetMap.get(abs));
      } else if (abs) {
        el.attr(attr, abs);
      }
    });
  };

  const rewriteSrcset = (selector) => {
    $(`${selector}[srcset]`).each((_, node) => {
      const el = $(node);
      const next = rewriteSrcsetValue(el.attr("srcset"), baseUrl, (abs) => assetMap.get(abs) || abs);
      if (next) el.attr("srcset", next);
    });
  };

  rewriteAttr("img", "src");
  rewriteAttr("source", "src");
  rewriteAttr("video", "poster");
  rewriteAttr("link", "href");
  rewriteSrcset("img");
  rewriteSrcset("source");
  ensureMobileMeta($);

  return {
    title,
    html: $.html()
  };
}

function rewriteSrcsetValue(value, baseUrl, mapUrl) {
  if (!value) return "";
  return value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const abs = absoluteUrl(parts[0], baseUrl);
      if (!abs) return candidate.trim();
      return [mapUrl(abs), ...parts.slice(1)].join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

function ensureMobileMeta($) {
  $("meta[charset]").remove();
  $("head").prepend("<meta charset=\"utf-8\">");
  if (!$("meta[name='viewport']").length) {
    $("head").append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">");
  }
}

function findAssetUrls(html, baseUrl, { full = false } = {}) {
  const $ = cheerio.load(html);
  const urls = new Set();

  const add = (value) => {
    const abs = absoluteUrl(value, baseUrl);
    if (abs && /^https?:\/\//i.test(abs)) urls.add(abs);
  };

  $("img[src]").each((_, el) => add($(el).attr("src")));
  $("img[srcset], source[srcset]").each((_, el) => {
    String($(el).attr("srcset") || "")
      .split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0])
      .forEach(add);
  });
  $("source[src], video[poster]").each((_, el) => {
    add($(el).attr("src"));
    add($(el).attr("poster"));
  });
  $("link[href]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    if (
      rel.includes("stylesheet") ||
      rel.includes("icon") ||
      (full && (rel.includes("preload") || rel.includes("apple-touch-icon")))
    ) {
      add($(el).attr("href"));
    }
  });
  return [...urls];
}

module.exports = {
  absoluteUrl,
  findAssetUrls,
  optimizeSingleHtml,
  rewriteForLocalAssetsFull,
  rewriteForLocalAssets,
  rewriteSrcsetValue,
  readableTitle
};
