const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const refreshBtn = document.getElementById("refreshBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");

const downloadsPanelEl = document.getElementById("downloadsPanel");
const downloadingListEl = document.getElementById("downloadingList");

let currentItems = [];
let currentTabId = null;
let currentTabTitle = "";
let downloadsPollTimer = null;

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

function renderDownloads(jobs = []) {
  const visibleJobs = jobs.slice(0, 10);
  downloadsPanelEl.classList.toggle("hidden", visibleJobs.length === 0);

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
  listEl.innerHTML = "";
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
  downloadAllBtn.disabled = items.length === 0;

  if (!items.length) {
    setStatus("m3u8-ссылки не найдены на этой вкладке.");
    return;
  }

  setStatus(`Найдено плейлистов: ${items.length}`);

  items.forEach((entry, index) => {
    const card = document.createElement("li");
    card.className = "video-card";

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

    const meta = document.createElement("div");
    meta.className = "video-card-url";
    meta.textContent = entry.url;

    const button = document.createElement("button");
    button.className = "download-btn";
    button.textContent = "Скачать";
    button.addEventListener("click", () => downloadVideo(entry, index));

    content.append(title, meta, button);
    card.append(thumb, content);
    listEl.append(card);
  });
}

function downloadVideo(item, index) {
  const url = item?.url;
  const preferredName = item?.title || currentTabTitle;
  if (typeof url !== "string" || !url) {
    setStatus("Ошибка: ссылка на видео не найдена.");
    return;
  }

  setStatus(`Добавлено в загрузку видео #${index + 1}.`);

  chrome.runtime.sendMessage(
    {
      type: "DOWNLOAD_VIDEO",
      url,
      preferredName
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
