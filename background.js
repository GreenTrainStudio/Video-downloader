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

  if (message.type === "DOWNLOAD_M3U8") {
    const { url, filename } = message;
    if (typeof url !== "string" || !url) {
      sendResponse({ ok: false, error: "Invalid URL" });
      return;
    }

    chrome.downloads.download(
      {
        url,
        filename: filename || undefined,
        saveAs: true,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, downloadId });
      }
    );

    return true;
  }
});
