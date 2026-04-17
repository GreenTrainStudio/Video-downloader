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

function sanitizeFilename(name, extension = "ts") {
  const safe = String(name || "video")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  const base = safe || "video";
  return `${base}.${extension}`;
}

function playlistBaseName(url) {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop() || "video";
    return name.replace(/\.m3u8($|\?.*)/i, "") || "video";
  } catch {
    return "video";
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

function parseMediaPlaylist(mediaText, baseUrl) {
  const lines = mediaText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const segments = [];
  let initSegment = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY")) {
      throw new Error("Зашифрованный поток (EXT-X-KEY) не поддерживается.");
    }

    if (line.startsWith("#EXT-X-MAP")) {
      const mapUri = parseAttribute(line, "URI");
      if (mapUri) {
        initSegment = absoluteUrl(mapUri, baseUrl);
      }
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    const resolved = absoluteUrl(line, baseUrl);
    if (resolved) {
      segments.push(resolved);
    }
  }

  if (initSegment) {
    segments.unshift(initSegment);
  }

  if (!segments.length) {
    throw new Error("Не удалось найти сегменты видео в плейлисте.");
  }

  return segments;
}

async function fetchBinary(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} при загрузке сегмента`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadSegmentsConcurrently(urls, concurrency = 8) {
  const results = new Array(urls.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < urls.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fetchBinary(urls[current]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function toBlobUrl(chunks) {
  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(totalSize);

  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return URL.createObjectURL(new Blob([merged], { type: "video/mp2t" }));
}

async function buildVideoFromM3u8(m3u8Url) {
  const firstText = await fetchText(m3u8Url);

  let mediaUrl = m3u8Url;
  let mediaText = firstText;

  if (firstText.includes("#EXT-X-STREAM-INF")) {
    const bestVariant = extractVariantPlaylist(firstText, m3u8Url);
    if (!bestVariant) {
      throw new Error("Не удалось выбрать вариант качества из master playlist.");
    }
    mediaUrl = bestVariant.url;
    mediaText = await fetchText(mediaUrl);
  }

  const segmentUrls = parseMediaPlaylist(mediaText, mediaUrl);
  const chunks = await downloadSegmentsConcurrently(segmentUrls, 8);

  return {
    blobUrl: toBlobUrl(chunks),
    segmentCount: segmentUrls.length,
    filename: sanitizeFilename(playlistBaseName(mediaUrl), "ts")
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
      let blobUrl = null;
      try {
        const result = await buildVideoFromM3u8(url);
        blobUrl = result.blobUrl;

        chrome.downloads.download(
          {
            url: blobUrl,
            filename: result.filename,
            saveAs: false,
            conflictAction: "uniquify"
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ ok: true, downloadId, segmentCount: result.segmentCount });
            }
            if (blobUrl) {
              URL.revokeObjectURL(blobUrl);
            }
          }
        );
      } catch (error) {
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
        }
        sendResponse({ ok: false, error: error.message || "Не удалось собрать видео" });
      }
    })();

    return true;
  }
});
