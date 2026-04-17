const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const refreshBtn = document.getElementById("refreshBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");

let currentUrls = [];
let currentTabId = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function renderList(urls) {
  listEl.innerHTML = "";
  currentUrls = urls;
  downloadAllBtn.disabled = urls.length === 0;

  if (!urls.length) {
    setStatus("m3u8-ссылки не найдены на этой вкладке.");
    return;
  }

  setStatus(`Найдено плейлистов: ${urls.length}`);

  urls.forEach((url, index) => {
    const item = document.createElement("li");
    item.className = "item";

    const text = document.createElement("div");
    text.className = "url";
    text.textContent = url;

    const button = document.createElement("button");
    button.className = "download-btn";
    button.textContent = "Скачать видео";
    button.addEventListener("click", () => downloadVideo(url, index));

    item.append(text, button);
    listEl.append(item);
  });
}

function downloadVideo(url, index) {
  setStatus(`Собираем видео #${index + 1}...`);

  chrome.runtime.sendMessage(
    {
      type: "DOWNLOAD_VIDEO",
      url
    },
    (response) => {
      if (!response?.ok) {
        setStatus(`Ошибка: ${response?.error || "неизвестная ошибка"}`);
        return;
      }

      setStatus(`Видео #${index + 1} сохранено (${response.segmentCount} сегм.).`);
    }
  );
}

function getActiveTabId() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (typeof tabId === "number") {
        resolve(tabId);
      } else {
        reject(new Error("Active tab not found"));
      }
    });
  });
}

function loadUrls() {
  setStatus("Ищем m3u8-ссылки...");

  chrome.runtime.sendMessage({ type: "GET_M3U8", tabId: currentTabId }, (response) => {
    const urls = Array.isArray(response?.urls) ? response.urls : [];
    renderList(urls);
  });
}

refreshBtn.addEventListener("click", loadUrls);

downloadAllBtn.addEventListener("click", () => {
  currentUrls.forEach((url, index) => downloadVideo(url, index));
});

(async () => {
  try {
    currentTabId = await getActiveTabId();
    loadUrls();
  } catch (error) {
    setStatus(`Ошибка: ${error.message}`);
  }
})();
