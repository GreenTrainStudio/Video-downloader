const statusEl = document.getElementById("status");
const videoQueueListEl = document.getElementById("videoQueueList");
const refreshBtn = document.getElementById("refreshBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");

const downloadsPanelEl = document.getElementById("downloadsPanel");

let currentItems = [];
let currentTabId = null;
let currentTabTitle = "";
let downloadsPollTimer = null;
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
  downloadsPanelEl.classList.toggle("hidden", currentItems.length === 0 && latestJobs.length === 0);
}

function getJobForUrl(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }
  return latestJobs.find((job) => job.url === url) || null;
}

function renderUnifiedList() {
  videoQueueListEl.innerHTML = "";
  const usedUrls = new Set();
  const entries = [];

  currentItems.forEach((item) => {
    const job = getJobForUrl(item.url);
    if (item.url) {
      usedUrls.add(item.url);
    }
    entries.push({
      url: item.url,
      title: item.title,
      previewUrl: item.previewUrl,
      job
    });
  });

  latestJobs.forEach((job) => {
    if (usedUrls.has(job.url)) {
      return;
    }
    entries.push({
      url: job.url,
      title: job.name || toDisplayName(job),
      previewUrl: "",
      job
    });
  });

  entries.slice(0, 12).forEach((entry, index) => {
    const card = document.createElement("li");
    card.className = `video-card ${entry.job ? `status-${entry.job.status}` : ""}`.trim();

    const thumb = document.createElement("img");
    thumb.className = "video-thumb";
    thumb.alt = "Превью видео";
    thumb.loading = "lazy";
    thumb.referrerPolicy = "no-referrer";
    thumb.src = entry.previewUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='136' height='76'%3E%3Crect width='100%25' height='100%25' fill='%231e293b'/%3E%3Cpolygon points='54,24 54,52 82,38' fill='%2394a3b8'/%3E%3C/svg%3E";

    const content = document.createElement("div");
    content.className = "video-card-content";

    const title = document.createElement("div");
    title.className = "video-card-title";
    title.textContent = entry.title || "Видео";

    const controls = document.createElement("div");
    controls.className = "video-card-controls";

    const button = document.createElement("button");
    button.className = "download-btn";
    button.textContent = "Скачать";

    const hasActiveJob = entry.job && !isDismissibleJob(entry.job);
    if (hasActiveJob) {
      button.disabled = true;
      button.textContent = "Скачивается…";
    } else {
      button.addEventListener("click", () => downloadVideo(entry, index));
    }

    controls.append(button);

    if (entry.job && isDismissibleJob(entry.job)) {
      const closeBtn = document.createElement("button");
      closeBtn.className = "dismiss-btn";
      closeBtn.type = "button";
      closeBtn.title = "Скрыть выполненную загрузку";
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", () => dismissDownload(entry.job.id));
      controls.append(closeBtn);
    }

    content.append(title, controls);

    if (entry.job) {
      const progressTrack = document.createElement("div");
      progressTrack.className = "video-progress-track";

      const progressFill = document.createElement("div");
      progressFill.className = "video-progress-fill";
      progressFill.style.width = formatPercent(entry.job.progress);
      progressTrack.append(progressFill);

      const details = document.createElement("div");
      details.className = "video-meta";
      const state = statusLabel(entry.job.status);
      const perc = formatPercent(entry.job.progress);
      const segPart = entry.job.totalSegments > 0 ? `${entry.job.completedSegments}/${entry.job.totalSegments} сегм.` : "— сегм.";
      const etaPart = entry.job.status === "error" ? (entry.job.error || "Неизвестная ошибка") : `ETA: ${formatEta(entry.job.etaSeconds)}`;
      details.textContent = `${state} • ${perc} • ${segPart} • ${etaPart}`;
      content.append(progressTrack, details);
    }

    card.append(thumb, content);
    videoQueueListEl.append(card);
  });
}

function renderList(urls) {
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
  renderUnifiedList();
  downloadAllBtn.disabled = items.length === 0;

  if (!items.length) {
    setStatus("m3u8-ссылки не найдены на этой вкладке.");
    return;
  }

  setStatus(`Найдено плейлистов: ${items.length}`);
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
    latestJobs = Array.isArray(response?.jobs) ? response.jobs.slice(0, 20) : [];
    updateDownloadsPanelVisibility();
    renderUnifiedList();
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
