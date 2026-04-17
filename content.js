function resolveUrl(candidate) {
  try {
    return new URL(candidate, location.href).toString();
  } catch {
    return null;
  }
}

function collectFromText(text) {
  if (typeof text !== "string" || !text) {
    return [];
  }

  const pattern = /(?:https?:\\/\\/|\\/)[^\"'\\s<>]+?\.m3u8(?:\?[^\"'\\s<>]*)?/gi;
  const matches = text.match(pattern) || [];

  return matches
    .map(resolveUrl)
    .filter((url) => typeof url === "string" && url.includes(".m3u8"));
}

function findM3u8Urls() {
  const found = new Set();

  collectFromText(document.documentElement?.outerHTML || "").forEach((url) => found.add(url));

  for (const script of document.scripts) {
    collectFromText(script.textContent || "").forEach((url) => found.add(url));
    if (script.src && script.src.includes(".m3u8")) {
      found.add(resolveUrl(script.src));
    }
  }

  for (const source of document.querySelectorAll("source[src], video[src], a[href]")) {
    const attr = source.getAttribute("src") || source.getAttribute("href");
    if (attr && attr.includes(".m3u8")) {
      const resolved = resolveUrl(attr);
      if (resolved) {
        found.add(resolved);
      }
    }
  }

  if (window.performance?.getEntriesByType) {
    const resources = window.performance.getEntriesByType("resource");
    for (const entry of resources) {
      if (entry.name && entry.name.includes(".m3u8")) {
        found.add(entry.name);
      }
    }
  }

  return Array.from(found).filter(Boolean);
}

function sendFoundUrls() {
  const urls = findM3u8Urls();
  if (!urls.length) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "FOUND_M3U8",
    urls
  });
}

sendFoundUrls();

const observer = new MutationObserver(() => sendFoundUrls());
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true
});

setInterval(sendFoundUrls, 5000);
