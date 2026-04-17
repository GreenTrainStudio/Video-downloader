const tabStreams = new Map();
const activeDownloads = new Map();
let nextDownloadJobId = 1;
const DOWNLOAD_JOB_TTL_MS = 60 * 60 * 1000;
const TERMINAL_JOB_STATUSES = new Set(["done", "error"]);

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

function createDownloadJob(url, preferredName = "") {
  const id = String(nextDownloadJobId);
  nextDownloadJobId += 1;

  const now = Date.now();
  const trimmedName = typeof preferredName === "string" ? preferredName.trim() : "";
  const name = trimmedName || playlistBaseName(url);
  const job = {
    id,
    url,
    name,
    status: "preparing",
    progress: 0,
    completedSegments: 0,
    totalSegments: 0,
    startTime: now,
    updatedAt: now,
    etaSeconds: null,
    filename: null,
    error: null,
    downloadId: null,
    completedAt: null
  };

  activeDownloads.set(id, job);
  return job;
}

function estimateEtaSeconds(job) {
  if (!job.totalSegments || job.completedSegments <= 0) {
    return null;
  }

  const elapsedSeconds = (Date.now() - job.startTime) / 1000;
  const avgPerSegment = elapsedSeconds / job.completedSegments;
  const remaining = Math.max(job.totalSegments - job.completedSegments, 0);
  const eta = Math.round(avgPerSegment * remaining);
  return Number.isFinite(eta) ? eta : null;
}

function updateDownloadJob(jobId, patch = {}) {
  const job = activeDownloads.get(jobId);
  if (!job) {
    return;
  }

  Object.assign(job, patch);
  job.updatedAt = Date.now();

  if (job.status === "downloading") {
    job.etaSeconds = estimateEtaSeconds(job);
  } else if (job.status === "done") {
    job.etaSeconds = 0;
  }

  if (TERMINAL_JOB_STATUSES.has(job.status) && !job.completedAt) {
    job.completedAt = Date.now();
  }
}

function pruneDownloadJobs() {
  const now = Date.now();
  for (const [jobId, job] of activeDownloads.entries()) {
    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      continue;
    }

    const completedAt = Number(job.completedAt) || Number(job.updatedAt) || now;
    if (now - completedAt >= DOWNLOAD_JOB_TTL_MS) {
      activeDownloads.delete(jobId);
    }
  }
}

function snapshotDownloadJobs() {
  pruneDownloadJobs();
  return Array.from(activeDownloads.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((job) => ({ ...job }));
}

function parseHumanError(error) {
  if (!error) {
    return "Не удалось собрать видео";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || "Не удалось собрать видео";
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

async function downloadSegmentsConcurrently(urls, concurrency = 8, onProgress = null) {
  const results = new Array(urls.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < urls.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fetchBinary(urls[current]);
      completed += 1;
      if (typeof onProgress === "function") {
        onProgress(completed, urls.length);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function toDataUrl(chunks) {
  const totalSize = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(totalSize);

  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < merged.length; i += step) {
    const slice = merged.subarray(i, i + step);
    binary += String.fromCharCode(...slice);
  }

  const base64 = btoa(binary);
  return `data:video/mp2t;base64,${base64}`;
}

async function buildVideoFromM3u8(m3u8Url, preferredName = "", onProgress = null) {
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
  if (typeof onProgress === "function") {
    onProgress(0, segmentUrls.length);
  }

  const chunks = await downloadSegmentsConcurrently(segmentUrls, 8, onProgress);

  const trimmedName = typeof preferredName === "string" ? preferredName.trim() : "";
  const outputBaseName = trimmedName || playlistBaseName(mediaUrl);

  return {
    dataUrl: toDataUrl(chunks),
    segmentCount: segmentUrls.length,
    filename: sanitizeFilename(outputBaseName, "ts")
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

  if (message.type === "GET_DOWNLOADS") {
    sendResponse({ jobs: snapshotDownloadJobs() });
    return;
  }

  if (message.type === "DISMISS_DOWNLOAD") {
    const { jobId } = message;
    if (typeof jobId !== "string" || !jobId) {
      sendResponse({ ok: false, error: "Invalid jobId" });
      return;
    }

    const job = activeDownloads.get(jobId);
    if (!job) {
      sendResponse({ ok: false, error: "Job not found" });
      return;
    }

    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      sendResponse({ ok: false, error: "Job is not completed" });
      return;
    }

    activeDownloads.delete(jobId);
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "DOWNLOAD_VIDEO") {
    const { url, preferredName } = message;
    if (typeof url !== "string" || !url) {
      sendResponse({ ok: false, error: "Invalid URL" });
      return;
    }

    const job = createDownloadJob(url, preferredName);

    (async () => {
      let dataUrl = null;
      try {
        const result = await buildVideoFromM3u8(url, preferredName, (completedSegments, totalSegments) => {
          updateDownloadJob(job.id, {
            status: "downloading",
            completedSegments,
            totalSegments,
            progress: totalSegments > 0 ? completedSegments / totalSegments : 0,
            filename: null
          });
        });

        dataUrl = result.dataUrl;
        updateDownloadJob(job.id, {
          status: "finishing",
          progress: 1,
          completedSegments: result.segmentCount,
          totalSegments: result.segmentCount,
          filename: result.filename,
          etaSeconds: 0
        });

        chrome.downloads.download(
          {
            url: dataUrl,
            filename: result.filename,
            saveAs: false,
            conflictAction: "uniquify"
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              const err = chrome.runtime.lastError.message;
              updateDownloadJob(job.id, { status: "error", error: err });
              sendResponse({ ok: false, error: err, jobId: job.id });
            } else {
              updateDownloadJob(job.id, { status: "done", downloadId, error: null, etaSeconds: 0, progress: 1 });
              sendResponse({ ok: true, downloadId, segmentCount: result.segmentCount, jobId: job.id });
            }
          }
        );
      } catch (error) {
        const humanError = parseHumanError(error);
        updateDownloadJob(job.id, { status: "error", error: humanError });
        sendResponse({ ok: false, error: humanError, jobId: job.id });
      }
    })();

    return true;
  }
});
