const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const refreshBtn = document.getElementById("refreshBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");

let currentUrls = [];
let currentTabId = null;

function safeFileName(url, index) {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").filter(Boolean).pop() || `stream-${index + 1}.m3u8`;
    return last.endsWith(".m3u8") ? last : `${last}.m3u8`;
  } catch {
    return `stream-${index + 1}.m3u8`;
  }
}

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

  setStatus(`Найдено ссылок: ${urls.length}`);

  urls.forEach((url, index) => {
    const item = document.createElement("li");
    item.className = "item";

    const text = document.createElement("div");
    text.className = "url";
    text.textContent = url;

    const button = document.createElement("button");
    button.className = "download-btn";
    button.textContent = "Скачать";
    button.addEventListener("click", () => downloadUrl(url, index));

    item.append(text, button);
    listEl.append(item);
  });
}

function downloadUrl(url, index) {
  chrome.runtime.sendMessage(
    {
      type: "DOWNLOAD_M3U8",
      url,
      filename: safeFileName(url, index)
    },
    (response) => {
      if (!response?.ok) {
        setStatus(`Ошибка загрузки: ${response?.error || "неизвестная ошибка"}`);
      }
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
  currentUrls.forEach((url, index) => downloadUrl(url, index));
});

(async () => {
  try {
    currentTabId = await getActiveTabId();
    loadUrls();
  } catch (error) {
    setStatus(`Ошибка: ${error.message}`);
  }
})();
