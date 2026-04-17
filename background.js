const tabStreams = new Map();

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function getTabSet(tabId) {
  if (!tabStreams.has(tabId)) {
    tabStreams.set(tabId, new Set());
  }
  return tabStreams.get(tabId);
}

function updateBadge(tabId) {
  const count = tabStreams.get(tabId)?.size ?? 0;
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#0B8043" });
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
}

function addUrls(tabId, urls = []) {
  if (!Number.isInteger(tabId) || tabId < 0 || !Array.isArray(urls)) {
    return;
  }

  const set = getTabSet(tabId);
  let changed = false;

  for (const rawUrl of urls) {
    if (typeof rawUrl !== "string") {
      continue;
    }

    const url = normalizeUrl(rawUrl.trim());
    if (!url || !url.toLowerCase().includes(".m3u8")) {
      continue;
    }

    if (!set.has(url)) {
      set.add(url);
      changed = true;
    }
  }

  if (changed) {
    updateBadge(tabId);
  }
}

function parseAttribute(line, name) {
  const re = new RegExp(`${name}=([^,]+)`);
  const match = line.match(re);
  if (!match) {
    return null;
  }
  return match[1].replace(/^"|"$/g, "").trim();
}

function absoluteUrl(pathOrUrl, baseUrl) {
  try {
    return new URL(pathOrUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function sanitizeFilename(name, extension = "m3u8") {
  const safe = String(name || "stream")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  const base = safe || "stream";
  return `${base}.${extension}`;
}

function playlistBaseName(url) {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop() || "stream";
    return name.replace(/\.m3u8($|\?.*)/i, "") || "stream";
  } catch {
    return "stream";
  }
}

async function fetchText(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} при загрузке плейлиста`);
  }
  return response.text();
}

function extractVariantPlaylist(masterText, baseUrl) {
  const lines = masterText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let best = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    const bandwidth = Number.parseInt(parseAttribute(line, "BANDWIDTH") || "0", 10);
    const next = lines[i + 1];
    if (!next || next.startsWith("#")) {
      continue;
    }

    const resolved = absoluteUrl(next, baseUrl);
    if (!resolved) {
      continue;
    }

    if (!best || bandwidth > best.bandwidth) {
      best = { url: resolved, bandwidth };
    }
  }

  return best;
}

async function resolveFastestStreamUrl(m3u8Url) {
  const text = await fetchText(m3u8Url);
  if (!text.includes("#EXT-X-STREAM-INF")) {
    return {
      url: m3u8Url,
      bandwidth: null,
      filename: sanitizeFilename(playlistBaseName(m3u8Url), "m3u8")
    };
  }

  const best = extractVariantPlaylist(text, m3u8Url);
  if (!best) {
    throw new Error("Не удалось выбрать вариант качества из master playlist.");
  }

  return {
    url: best.url,
    bandwidth: best.bandwidth,
    filename: sanitizeFilename(playlistBaseName(best.url), "m3u8")
  };
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0 || !details.url) {
      return;
    }
    addUrls(details.tabId, [details.url]);
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabStreams.set(tabId, new Set());
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStreams.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "FOUND_M3U8") {
    const tabId = sender.tab?.id;
    addUrls(tabId, message.urls);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "GET_M3U8") {
    const tabId = message.tabId;
    const urls = Array.from(tabStreams.get(tabId) ?? []);
    sendResponse({ urls });
    return;
  }

  if (message.type === "DOWNLOAD_VIDEO") {
    const { url } = message;
    if (typeof url !== "string" || !url) {
      sendResponse({ ok: false, error: "Invalid URL" });
      return;
    }

    (async () => {
      try {
        const stream = await resolveFastestStreamUrl(url);

        chrome.downloads.download(
          {
            url: stream.url,
            filename: stream.filename,
            saveAs: true,
            conflictAction: "uniquify"
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            sendResponse({ ok: true, downloadId, bandwidth: stream.bandwidth, url: stream.url });
          }
        );
      } catch (error) {
        sendResponse({ ok: false, error: error.message || "Не удалось запустить загрузку" });
      }
    })();

    return true;
  }
});
