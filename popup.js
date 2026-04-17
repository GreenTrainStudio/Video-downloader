const statusEl = document.getElementById("status");
const availableListEl = document.getElementById("availableList");
const refreshBtn = document.getElementById("refreshBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");

const downloadsPanelEl = document.getElementById("downloadsPanel");
const downloadingListEl = document.getElementById("downloadingList");

let currentItems = [];
let currentTabId = null;
let currentTabTitle = "";
let downloadsPollTimer = null;
const previewStreamCache = new Map();
const loadingPreviewStreams = new Map();
let latestJobs = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }

  const rounded = Math.round(seconds);
  const min = Math.floor(rounded / 60);
  const sec = rounded % 60;

  if (min <= 0) {
    return `${sec} сек`;
  }

  if (sec === 0) {
    return `${min} мин`;
  }

  return `${min} мин ${sec} сек`;
}

function formatPercent(value) {
  const bounded = Math.max(0, Math.min(1, Number(value) || 0));
  return `${Math.round(bounded * 100)}%`;
}

function absoluteUrl(pathOrUrl, baseUrl) {
  try {
    return new URL(pathOrUrl, baseUrl).toString();
  } catch {
    return null;
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

async function fetchText(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

async function resolveLowResPreviewUrl(m3u8Url) {
  if (!m3u8Url || typeof m3u8Url !== "string") {
    return "";
  }

  if (previewStreamCache.has(m3u8Url)) {
    return previewStreamCache.get(m3u8Url);
  }

  if (loadingPreviewStreams.has(m3u8Url)) {
    return loadingPreviewStreams.get(m3u8Url);
  }

  const task = (async () => {
    try {
      const text = await fetchText(m3u8Url);
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      let selected = null;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.startsWith("#EXT-X-STREAM-INF")) {
          continue;
        }
        const next = lines[i + 1];
        if (!next || next.startsWith("#")) {
          continue;
        }

        const bandwidth = Number.parseInt(parseAttribute(line, "BANDWIDTH") || "0", 10);
        const resolved = absoluteUrl(next, m3u8Url);
        if (!resolved) {
          continue;
        }

        if (!selected || bandwidth < selected.bandwidth) {
          selected = { url: resolved, bandwidth };
        }
      }

      const previewUrl = selected?.url || m3u8Url;
      previewStreamCache.set(m3u8Url, previewUrl);
      return previewUrl;
    } catch {
      previewStreamCache.set(m3u8Url, m3u8Url);
      return m3u8Url;
    } finally {
      loadingPreviewStreams.delete(m3u8Url);
    }
  })();

  loadingPreviewStreams.set(m3u8Url, task);
  return task;
}

function attachVideoPreview(videoEl, m3u8Url) {
  resolveLowResPreviewUrl(m3u8Url).then((previewUrl) => {
    if (!previewUrl || !videoEl.isConnected) {
      return;
    }
    videoEl.src = previewUrl;
    videoEl.play().catch(() => {});
  });
}

function toDisplayName(job) {
  if (typeof job.filename === "string" && job.filename.trim()) {
    return job.filename;
  }
  if (typeof job.name === "string" && job.name.trim()) {
    return `${job.name}.ts`;
  }
  return "video.ts";
}

function statusLabel(status) {
  switch (status) {
    case "preparing":
      return "Подготовка";
    case "downloading":
      return "Скачивание";
    case "finishing":
      return "Финализация";
    case "done":
      return "Готово";
    case "error":
      return "Ошибка";
    default:
      return "Ожидание";
  }
}

function isDismissibleJob(job) {
  return job.status === "done" || job.status === "error";
}

function dismissDownload(jobId) {
  if (typeof jobId !== "string" || !jobId) {
    return;
  }

  chrome.runtime.sendMessage({ type: "DISMISS_DOWNLOAD", jobId }, () => {
    loadDownloads();
  });
}

function updateDownloadsPanelVisibility() {
  const hasAvailable = currentItems.length > 0;
  const hasJobs = latestJobs.length > 0;
  downloadsPanelEl.classList.toggle("hidden", !hasAvailable && !hasJobs);
}

function renderDownloads(jobs = []) {
  latestJobs = jobs.slice(0, 10);
  updateDownloadsPanelVisibility();

  const visibleJobs = jobs.slice(0, 10);
  downloadingListEl.innerHTML = "";
  visibleJobs.forEach((job) => {
    const item = document.createElement("li");
    item.className = `downloading-item status-${job.status}`;

    const title = document.createElement("div");
    title.className = "video-title";
    const titleText = document.createElement("span");
    titleText.className = "video-title-text";
    titleText.textContent = toDisplayName(job);
    title.append(titleText);
    if (isDismissibleJob(job)) {
      const closeBtn = document.createElement("button");
      closeBtn.className = "dismiss-btn";
      closeBtn.type = "button";
      closeBtn.title = "Скрыть выполненную загрузку";
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", () => dismissDownload(job.id));
      title.append(closeBtn);
    }

    const progressTrack = document.createElement("div");
    progressTrack.className = "video-progress-track";

    const progressFill = document.createElement("div");
    progressFill.className = "video-progress-fill";
    progressFill.style.width = formatPercent(job.progress);

    progressTrack.append(progressFill);

    const details = document.createElement("div");
    details.className = "video-meta";

    const state = statusLabel(job.status);
    const perc = formatPercent(job.progress);
    const segPart = job.totalSegments > 0 ? `${job.completedSegments}/${job.totalSegments} сегм.` : "— сегм.";
    const etaPart = job.status === "error" ? (job.error || "Неизвестная ошибка") : `ETA: ${formatEta(job.etaSeconds)}`;

    details.textContent = `${state} • ${perc} • ${segPart} • ${etaPart}`;

    item.append(title, progressTrack, details);
    downloadingListEl.append(item);
  });
}

function renderList(urls) {
  availableListEl.innerHTML = "";
  const items = urls
    .map((entry) => {
      if (typeof entry === "string") {
        return {
          url: entry,
          title: currentTabTitle || "Видео",
          previewUrl: ""
        };
      }
      return {
        url: entry?.url || "",
        title: entry?.title || currentTabTitle || "Видео",
        previewUrl: entry?.previewUrl || ""
      };
    })
    .filter((entry) => typeof entry.url === "string" && entry.url);

  currentItems = items;
  updateDownloadsPanelVisibility();
  downloadAllBtn.disabled = items.length === 0;

  if (!items.length) {
    setStatus("m3u8-ссылки не найдены на этой вкладке.");
    return;
  }

  setStatus(`Найдено плейлистов: ${items.length}`);

  items.forEach((entry, index) => {
    const card = document.createElement("li");
    card.className = "video-card";

    const thumb = document.createElement("video");
    thumb.className = "video-thumb";
    thumb.muted = true;
    thumb.autoplay = true;
    thumb.loop = true;
    thumb.playsInline = true;
    thumb.preload = "metadata";
    thumb.poster = entry.previewUrl || "";
    attachVideoPreview(thumb, entry.url);

    const content = document.createElement("div");
    content.className = "video-card-content";

    const title = document.createElement("div");
    title.className = "video-card-title";
    title.textContent = entry.title || "Видео";

    const button = document.createElement("button");
    button.className = "download-btn";
    button.textContent = "Скачать";
    button.addEventListener("click", () => downloadVideo(entry, index));

    content.append(title, button);
    card.append(thumb, content);
    availableListEl.append(card);
  });
}

function downloadVideo(item, index) {
  const url = item?.url;
  const preferredName = currentTabTitle || item?.title || "";
  if (typeof url !== "string" || !url) {
    setStatus("Ошибка: ссылка на видео не найдена.");
    return;
  }

  setStatus(`Добавлено в загрузку видео #${index + 1}.`);

  chrome.runtime.sendMessage(
    {
      type: "DOWNLOAD_VIDEO",
      url,
      preferredName,
      sourceTabId: currentTabId
    },
    (response) => {
      if (!response?.ok) {
        setStatus(`Ошибка: ${response?.error || "неизвестная ошибка"}`);
        return;
      }

      setStatus(`Видео #${index + 1} сохранено (${response.segmentCount} сегм.).`);
      loadDownloads();
    }
  );
}

function getActiveTabInfo() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      const tabId = tab?.id;
      if (typeof tabId === "number") {
        resolve({
          id: tabId,
          title: typeof tab.title === "string" ? tab.title : ""
        });
      } else {
        reject(new Error("Active tab not found"));
      }
    });
  });
}

function loadUrls() {
  setStatus("Ищем m3u8-ссылки...");

  chrome.runtime.sendMessage({ type: "GET_M3U8", tabId: currentTabId }, (response) => {
    const items = Array.isArray(response?.items) ? response.items : (Array.isArray(response?.urls) ? response.urls : []);
    renderList(items);
  });
}

function loadDownloads() {
  chrome.runtime.sendMessage({ type: "GET_DOWNLOADS" }, (response) => {
    const jobs = Array.isArray(response?.jobs) ? response.jobs : [];
    renderDownloads(jobs);
  });
}

function startDownloadsPolling() {
  loadDownloads();
  if (downloadsPollTimer) {
    clearInterval(downloadsPollTimer);
  }
  downloadsPollTimer = setInterval(loadDownloads, 1000);
}

refreshBtn.addEventListener("click", loadUrls);

downloadAllBtn.addEventListener("click", () => {
  currentItems.forEach((item, index) => downloadVideo(item, index));
});

window.addEventListener("unload", () => {
  if (downloadsPollTimer) {
    clearInterval(downloadsPollTimer);
    downloadsPollTimer = null;
  }
});

(async () => {
  try {
    const activeTab = await getActiveTabInfo();
    currentTabId = activeTab.id;
    currentTabTitle = activeTab.title;
    loadUrls();
    startDownloadsPolling();
  } catch (error) {
    setStatus(`Ошибка: ${error.message}`);
  }
})();
