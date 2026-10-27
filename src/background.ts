import {
  BUILD_ID,
  CONTENT_HOST_ID,
  DISABLED_SITES_STORAGE_KEY,
  FLOATER_POSITION_STORAGE_KEY,
  MAX_STACK_SIZE,
  SNAPSTACK_ENABLED_STORAGE_KEY,
  STACK_INDEX_STORAGE_KEY,
  STACK_ITEM_STORAGE_PREFIX,
  STACK_STORAGE_KEY
} from "./lib/constants";
import type {
  CaptureItem,
  CapturePreviewItem,
  CaptureRegion,
  ContextImageTarget,
  ExtensionMessage,
  ExtensionResponse,
  FloaterPosition,
  SiteState,
  StackState
} from "./lib/types";

let mutationQueue = Promise.resolve();
let migrationPromise: Promise<void> | null = null;
const contentInjectionTasks = new Map<number, Promise<boolean>>();
const pendingScreenshots = new Map<string, { dataUrl: string; createdAt: number }>();
const SITE_TOGGLE_MENU_ID = "snapstack-site-enabled";
const SAVE_IMAGE_MENU_ID = "snapstack-save-image";
const PENDING_SCREENSHOT_TTL_MS = 30_000;

function isSupportedPage(url?: string) {
  return Boolean(url && (url.startsWith("https://") || url.startsWith("http://")));
}

async function getSnapStackEnabled() {
  const stored = await chrome.storage.local.get(SNAPSTACK_ENABLED_STORAGE_KEY);
  return stored[SNAPSTACK_ENABLED_STORAGE_KEY] === true;
}

function hostnameOf(url?: string) {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

async function getDisabledSites() {
  const stored = await chrome.storage.local.get(DISABLED_SITES_STORAGE_KEY);
  return (stored[DISABLED_SITES_STORAGE_KEY] as string[] | undefined) ?? [];
}

async function isSiteEnabled(url?: string) {
  return isSupportedPage(url)
    && await getSnapStackEnabled()
    && !(await getDisabledSites()).includes(hostnameOf(url));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function updateActionTitle(tab: chrome.tabs.Tab) {
  if (!tab.id) return;
  const supported = isSupportedPage(tab.url);
  const enabled = supported && await isSiteEnabled(tab.url);
  const title = !supported
    ? "SnapStack — Not available on this page"
    : enabled
      ? "SnapStack — Enabled"
      : await getSnapStackEnabled()
        ? "SnapStack — Off on this site"
        : "SnapStack — Disabled";
  await chrome.action.setTitle({ tabId: tab.id, title });
}

// Each tab gets its own value because a site can be turned off while SnapStack stays on elsewhere.
async function syncEnabledStateToTabs() {
  const [tabs, globalEnabled, disabledSites] = await Promise.all([
    chrome.tabs.query({}),
    getSnapStackEnabled(),
    getDisabledSites()
  ]);
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !isSupportedPage(tab.url)) return;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "SITE_ENABLED_CHANGED",
        enabled: globalEnabled && !disabledSites.includes(hostnameOf(tab.url))
      } satisfies ExtensionMessage);
    } catch {
      // Tabs without an active SnapStack content script can sync on their next load.
    }
  }));
}

async function setSiteDisabled(tab: chrome.tabs.Tab, disabled: boolean) {
  const hostname = hostnameOf(tab.url);
  if (!isSupportedPage(tab.url) || !hostname) {
    throw new Error("SnapStack cannot be changed on this page.");
  }
  const otherSites = (await getDisabledSites()).filter((site) => site !== hostname);
  await chrome.storage.local.set({
    [DISABLED_SITES_STORAGE_KEY]: disabled ? [...otherSites, hostname] : otherSites
  });
  const tabs = await chrome.tabs.query({});
  void Promise.all([
    syncEnabledStateToTabs(),
    ...tabs.map((candidate) => updateActionTitle(candidate))
  ]).catch(() => {
    // The saved site list remains authoritative if a tab closes during sync.
  });
}

async function updateSiteToggleMenu(tab: chrome.tabs.Tab) {
  try {
    await chrome.contextMenus.update(SITE_TOGGLE_MENU_ID, {
      checked: await getSnapStackEnabled(),
      enabled: true
    });
  } catch {
    // The menu is recreated whenever the service worker starts.
  }
}

async function setSiteEnabled(tab: chrome.tabs.Tab, enabled: boolean) {
  await chrome.storage.local.set({
    [SNAPSTACK_ENABLED_STORAGE_KEY]: enabled
  });
  const tabs = await chrome.tabs.query({});
  void Promise.all([
    syncEnabledStateToTabs(),
    ...tabs.map((candidate) => updateActionTitle(candidate)),
    tab.active ? updateSiteToggleMenu(tab) : Promise.resolve()
  ]).catch(() => {
    // The saved global setting remains authoritative if a tab closes during sync.
  });
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: SITE_TOGGLE_MENU_ID,
      title: "Enable SnapStack",
      type: "checkbox",
      checked: true,
      contexts: ["action"]
    });
    chrome.contextMenus.create({
      id: SAVE_IMAGE_MENU_ID,
      title: "Save to SnapStack",
      contexts: ["image", "link"]
    });
    void activeTab().then((tab) => tab && updateSiteToggleMenu(tab));
  });
}

async function pingContent(tabId: number) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: "PING" } satisfies ExtensionMessage
    ) as ExtensionResponse<string>;
    return response?.ok === true && response.data === BUILD_ID;
  } catch {
    return false;
  }
}

async function waitForContent(tabId: number) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await pingContent(tabId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function injectContentInTab(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedPage(tab.url)) return false;

  if (await pingContent(tabId)) return true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (hostId: string) => Boolean(document.getElementById(hostId)),
      args: [CONTENT_HOST_ID]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (hostId: string) => document.getElementById(hostId)?.remove(),
      args: [CONTENT_HOST_ID]
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await waitForContent(tabId);
  } catch {
    return false;
  }
}

function ensureContentInTab(tabId: number) {
  const existingTask = contentInjectionTasks.get(tabId);
  if (existingTask) return existingTask;

  const task = injectContentInTab(tabId).finally(() => {
    contentInjectionTasks.delete(tabId);
  });
  contentInjectionTasks.set(tabId, task);
  return task;
}

async function getState(url?: string): Promise<StackState> {
  const [items, site] = await Promise.all([
    getPreviewItems(),
    getSiteState(url)
  ]);
  return { items, ...site };
}

async function getSiteState(url?: string): Promise<SiteState> {
  const [globalEnabled, disabledSites] = await Promise.all([
    getSnapStackEnabled(),
    getDisabledSites()
  ]);
  const hostname = hostnameOf(url);
  return {
    siteEnabled: globalEnabled && !disabledSites.includes(hostname),
    siteSupported: isSupportedPage(url),
    globalEnabled,
    hostname
  };
}

function captureStorageKey(id: string) {
  return `${STACK_ITEM_STORAGE_PREFIX}${id}`;
}

function toPreviewItem(item: CaptureItem): CapturePreviewItem {
  const { imageDataUrl: _imageDataUrl, ...preview } = item;
  return {
    ...preview,
    thumbnailDataUrl: item.thumbnailDataUrl || item.imageDataUrl
  };
}

function newestFirst<T extends { capturedAt: number }>(items: T[]) {
  return [...items].sort((a, b) => b.capturedAt - a.capturedAt);
}

function ensureStackMigrated() {
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    const stored = await chrome.storage.local.get([
      STACK_INDEX_STORAGE_KEY,
      STACK_STORAGE_KEY
    ]);
    if (Array.isArray(stored[STACK_INDEX_STORAGE_KEY])) return;

    const legacyItems = newestFirst(
      (stored[STACK_STORAGE_KEY] as CaptureItem[] | undefined) ?? []
    ).slice(0, MAX_STACK_SIZE);
    const migrated: Record<string, unknown> = {
      [STACK_INDEX_STORAGE_KEY]: legacyItems.map(toPreviewItem)
    };
    for (const item of legacyItems) migrated[captureStorageKey(item.id)] = item;
    await chrome.storage.local.set(migrated);
    if (stored[STACK_STORAGE_KEY] !== undefined) {
      await chrome.storage.local.remove(STACK_STORAGE_KEY);
    }
  })().catch((error) => {
    migrationPromise = null;
    throw error;
  });

  return migrationPromise;
}

async function getPreviewItems() {
  await ensureStackMigrated();
  const stored = await chrome.storage.local.get(STACK_INDEX_STORAGE_KEY);
  return newestFirst(
    (stored[STACK_INDEX_STORAGE_KEY] as CapturePreviewItem[] | undefined) ?? []
  );
}

async function getCaptureItem(id: string) {
  await ensureStackMigrated();
  const key = captureStorageKey(id);
  const stored = await chrome.storage.local.get(key);
  return stored[key] as CaptureItem | undefined;
}

async function getCaptureItems() {
  const previews = await getPreviewItems();
  const keys = previews.map((item) => captureStorageKey(item.id));
  if (!keys.length) return [];
  const stored = await chrome.storage.local.get(keys);
  return previews
    .map((preview) => stored[captureStorageKey(preview.id)] as CaptureItem | undefined)
    .filter((item): item is CaptureItem => Boolean(item));
}

function queueStackMutation<T>(operation: () => Promise<T>) {
  const task = mutationQueue.then(operation, operation);
  mutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function broadcastToContent(
  message: ExtensionMessage,
  predicate: (tab: chrome.tabs.Tab) => boolean = () => true
) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter(predicate).map(async (tab) => {
    if (!tab.id || !isSupportedPage(tab.url)) return;
    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      // Tabs without an active SnapStack content script can sync on their next load.
    }
  }));
}

async function notifyStackUpdated(items: CapturePreviewItem[]) {
  const tabs = await chrome.tabs.query({ active: true });
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !isSupportedPage(tab.url)) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "STACK_UPDATED", items });
    } catch {
      // The tab will request the current stack when its content script starts.
    }
  }));
}

async function syncStackToTab(tabId: number) {
  if (!await ensureContentInTab(tabId)) return;
  try {
    const [items, stored] = await Promise.all([
      getPreviewItems(),
      chrome.storage.local.get(FLOATER_POSITION_STORAGE_KEY)
    ]);
    const position = stored[FLOATER_POSITION_STORAGE_KEY] as FloaterPosition | undefined;
    await Promise.all([
      chrome.tabs.sendMessage(tabId, {
        type: "STACK_UPDATED",
        items
      } satisfies ExtensionMessage),
      position
        ? chrome.tabs.sendMessage(tabId, {
          type: "FLOATER_POSITION_CHANGED",
          position
        } satisfies ExtensionMessage)
        : Promise.resolve()
    ]);
  } catch {
    // A navigation can replace the content script while the state is loading.
  }
}

function addCaptureToStack(item: CaptureItem) {
  return queueStackMutation(async () => {
    const current = await getPreviewItems();
    const next = [toPreviewItem(item), ...current].slice(0, MAX_STACK_SIZE);
    const retainedIds = new Set(next.map((preview) => preview.id));
    const removedKeys = current
      .filter((preview) => !retainedIds.has(preview.id))
      .map((preview) => captureStorageKey(preview.id));
    await chrome.storage.local.set({
      [captureStorageKey(item.id)]: item,
      [STACK_INDEX_STORAGE_KEY]: next
    });
    if (removedKeys.length) await chrome.storage.local.remove(removedKeys);
    void notifyStackUpdated(next);
    return toPreviewItem(item);
  });
}

function removeCaptureFromStack(id: string) {
  return queueStackMutation(async () => {
    const next = (await getPreviewItems()).filter((item) => item.id !== id);
    await chrome.storage.local.set({ [STACK_INDEX_STORAGE_KEY]: next });
    void notifyStackUpdated(next);
    void chrome.storage.local.remove(captureStorageKey(id)).catch(() => {
      // Keep the visible stack responsive even if best-effort payload cleanup fails.
    });
  });
}

function moveCaptureInStack(id: string, direction: -1 | 1) {
  return queueStackMutation(async () => {
    const next = [...await getPreviewItems()];
    const currentIndex = next.findIndex((item) => item.id === id);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= next.length) return;
    [next[currentIndex], next[nextIndex]] = [next[nextIndex], next[currentIndex]];
    await chrome.storage.local.set({ [STACK_INDEX_STORAGE_KEY]: next });
    void notifyStackUpdated(next);
  });
}

function clearStackForUndo() {
  return queueStackMutation(async () => {
    const current = await getPreviewItems();
    await chrome.storage.local.set({ [STACK_INDEX_STORAGE_KEY]: [] });
    void notifyStackUpdated([]);
    return current;
  });
}

function restoreClearedStack(clearedItems: CapturePreviewItem[]) {
  return queueStackMutation(async () => {
    const current = await getPreviewItems();
    const currentIds = new Set(current.map((item) => item.id));
    const restored = newestFirst([
      ...clearedItems.filter((item) => !currentIds.has(item.id)),
      ...current
    ]).slice(0, MAX_STACK_SIZE);
    const restoredIds = new Set(restored.map((item) => item.id));
    const unrestoredKeys = clearedItems
      .filter((item) => !restoredIds.has(item.id))
      .map((item) => captureStorageKey(item.id));
    await chrome.storage.local.set({ [STACK_INDEX_STORAGE_KEY]: restored });
    if (unrestoredKeys.length) await chrome.storage.local.remove(unrestoredKeys);
    void notifyStackUpdated(restored);
    return restored;
  });
}

function commitClearedStack(ids: string[]) {
  return queueStackMutation(async () => {
    const retainedIds = new Set((await getPreviewItems()).map((item) => item.id));
    const keys = ids
      .filter((id) => !retainedIds.has(id))
      .map(captureStorageKey);
    if (keys.length) await chrome.storage.local.remove(keys);
  });
}

async function blobToDataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

function prunePendingScreenshots() {
  const oldestAllowed = Date.now() - PENDING_SCREENSHOT_TTL_MS;
  for (const [token, screenshot] of pendingScreenshots) {
    if (screenshot.createdAt < oldestAllowed) pendingScreenshots.delete(token);
  }
}

async function cropCapturedScreenshot(
  screenshotDataUrl: string,
  rect: CaptureRegion,
  viewportWidth: number,
  viewportHeight: number
) {
  const sourceBlob = await fetch(screenshotDataUrl).then((response) => response.blob());
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    const scaleX = bitmap.width / Math.max(1, viewportWidth);
    const scaleY = bitmap.height / Math.max(1, viewportHeight);
    const sourceX = Math.max(0, Math.round(rect.x * scaleX));
    const sourceY = Math.max(0, Math.round(rect.y * scaleY));
    const width = Math.max(
      1,
      Math.min(bitmap.width - sourceX, Math.round(rect.width * scaleX))
    );
    const height = Math.max(
      1,
      Math.min(bitmap.height - sourceY, Math.round(rect.height * scaleY))
    );
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Your browser could not prepare the screenshot.");
    context.drawImage(bitmap, sourceX, sourceY, width, height, 0, 0, width, height);

    const thumbnailScale = Math.min(1, 320 / width, 220 / height);
    const thumbnailWidth = Math.max(1, Math.round(width * thumbnailScale));
    const thumbnailHeight = Math.max(1, Math.round(height * thumbnailScale));
    const thumbnailCanvas = new OffscreenCanvas(thumbnailWidth, thumbnailHeight);
    const thumbnailContext = thumbnailCanvas.getContext("2d", { alpha: false });
    if (!thumbnailContext) throw new Error("SnapStack could not prepare the image thumbnail.");
    thumbnailContext.drawImage(canvas, 0, 0, thumbnailWidth, thumbnailHeight);

    const [imageBlob, thumbnailBlob] = await Promise.all([
      canvas.convertToBlob({ type: "image/png" }),
      thumbnailCanvas.convertToBlob({ type: "image/webp", quality: 0.78 })
    ]);
    const [imageDataUrl, thumbnailDataUrl] = await Promise.all([
      blobToDataUrl(imageBlob),
      blobToDataUrl(thumbnailBlob)
    ]);

    return { imageDataUrl, thumbnailDataUrl, width, height };
  } finally {
    bitmap.close();
  }
}

async function normalizeContextImage(imageUrl: string) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error(`The image could not be loaded (${response.status}).`);
  const sourceBlob = await response.blob();
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    if (!bitmap.width || !bitmap.height) throw new Error("The selected image is empty.");
    const maxDimension = 8_192;
    const maxPixels = 32_000_000;
    const scale = Math.min(
      1,
      maxDimension / bitmap.width,
      maxDimension / bitmap.height,
      Math.sqrt(maxPixels / (bitmap.width * bitmap.height))
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("SnapStack could not prepare this image.");
    context.drawImage(bitmap, 0, 0, width, height);
    const imageBlob = await canvas.convertToBlob({ type: "image/png" });

    const thumbnailScale = Math.min(1, 320 / width, 220 / height);
    const thumbnailWidth = Math.max(1, Math.round(width * thumbnailScale));
    const thumbnailHeight = Math.max(1, Math.round(height * thumbnailScale));
    const thumbnailCanvas = new OffscreenCanvas(thumbnailWidth, thumbnailHeight);
    const thumbnailContext = thumbnailCanvas.getContext("2d", { alpha: false });
    if (!thumbnailContext) throw new Error("SnapStack could not prepare the image thumbnail.");
    thumbnailContext.drawImage(canvas, 0, 0, thumbnailWidth, thumbnailHeight);
    const thumbnailBlob = await thumbnailCanvas.convertToBlob({ type: "image/webp", quality: 0.78 });

    return {
      imageDataUrl: await blobToDataUrl(imageBlob),
      thumbnailDataUrl: await blobToDataUrl(thumbnailBlob),
      width,
      height
    };
  } finally {
    bitmap.close();
  }
}

async function showToastInTab(tabId: number, message: string) {
  if (!await ensureContentInTab(tabId)) return;
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: "SHOW_TOAST", message } satisfies ExtensionMessage
    );
  } catch {
    // Saving the image still succeeds when a page cannot display the toast.
  }
}

async function resolveContextImageTarget(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab
): Promise<ContextImageTarget> {
  let contentTarget: ContextImageTarget | undefined;
  if (tab.id && await ensureContentInTab(tab.id)) {
    try {
      const response = await chrome.tabs.sendMessage(
        tab.id,
        { type: "GET_CONTEXT_IMAGE_URL" } satisfies ExtensionMessage
      ) as ExtensionResponse<ContextImageTarget | string>;
      if (response.ok && typeof response.data === "string") {
        contentTarget = {
          url: response.data,
          viewportWidth: tab.width ?? 1,
          viewportHeight: tab.height ?? 1
        };
      } else if (response.ok && response.data && typeof response.data === "object") {
        contentTarget = response.data;
      }
    } catch {
      // Fall through to the direct image-link check.
    }
  }
  if (info.srcUrl) return { ...contentTarget, url: info.srcUrl } as ContextImageTarget;
  if (contentTarget) return contentTarget;
  if (info.linkUrl && /^(?:data:image\/|blob:|https?:\/\/.*\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$)/i.test(info.linkUrl)) {
    return {
      url: info.linkUrl,
      viewportWidth: tab.width ?? 1,
      viewportHeight: tab.height ?? 1
    };
  }
  throw new Error("No image was found in this linked card.");
}

async function captureVisibleContextImage(target: ContextImageTarget, tab: chrome.tabs.Tab) {
  if (!tab.id || tab.windowId === undefined || !target.rect) {
    throw new Error("The linked image could not be read or captured.");
  }

  let hostHidden = false;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [CONTENT_HOST_ID],
      func: async (hostId) => {
        const host = document.getElementById(hostId);
        if (!host) return false;
        host.dataset.snapstackPreviousVisibility = host.style.visibility;
        host.style.setProperty("visibility", "hidden", "important");
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        return true;
      }
    });
    hostHidden = result?.result === true;
  } catch {
    // Cropping still works when the page does not currently contain the floater.
  }

  try {
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return await cropCapturedScreenshot(
      screenshotDataUrl,
      target.rect,
      target.viewportWidth,
      target.viewportHeight
    );
  } finally {
    if (hostHidden) {
      void chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [CONTENT_HOST_ID],
        func: (hostId) => {
          const host = document.getElementById(hostId);
          if (!host) return;
          const previous = host.dataset.snapstackPreviousVisibility;
          if (previous) host.style.setProperty("visibility", previous, "important");
          else host.style.removeProperty("visibility");
          delete host.dataset.snapstackPreviousVisibility;
        }
      }).catch(() => {
        // A navigation can replace the content script while the image is being saved.
      });
    }
  }
}

async function saveContextImage(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) {
  const target = await resolveContextImageTarget(info, tab);
  let normalized: Awaited<ReturnType<typeof normalizeContextImage>> | undefined;
  if (target.url) {
    try {
      normalized = await normalizeContextImage(target.url);
    } catch {
      // Protected and lazy-loaded images are captured from their visible card below.
    }
  }
  normalized ??= await captureVisibleContextImage(target, tab);
  const item: CaptureItem = {
    ...normalized,
    id: crypto.randomUUID(),
    sourceTitle: tab.title || "Saved image",
    sourceUrl: info.pageUrl || tab.url || target.url || "",
    capturedAt: Date.now()
  };
  if (!await getSnapStackEnabled()) await setSiteEnabled(tab, true);
  if ((await getDisabledSites()).includes(hostnameOf(tab.url))) await setSiteDisabled(tab, false);
  await addCaptureToStack(item);
  if (tab.id) {
    await syncStackToTab(tab.id);
    await showToastInTab(tab.id, "Saved image to SnapStack");
  }
}

async function beginCaptureInTab(tabId?: number) {
  if (!tabId) throw new Error("No active tab is available.");
  const tab = await chrome.tabs.get(tabId);
  if (!await isSiteEnabled(tab.url)) throw new Error("SnapStack is disabled.");
  const ready = await ensureContentInTab(tabId);
  if (!ready) throw new Error("SnapStack cannot run on this Chrome page.");
  await chrome.tabs.sendMessage(tabId, { type: "BEGIN_CAPTURE" } satisfies ExtensionMessage);
}

async function beginCaptureInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await beginCaptureInTab(tab?.id);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  createContextMenus();
  const state = await chrome.storage.local.get([
    DISABLED_SITES_STORAGE_KEY,
    SNAPSTACK_ENABLED_STORAGE_KEY
  ]);
  await ensureStackMigrated();
  const initialState: Record<string, unknown> = {
    [DISABLED_SITES_STORAGE_KEY]: state[DISABLED_SITES_STORAGE_KEY] ?? []
  };
  if (typeof state[SNAPSTACK_ENABLED_STORAGE_KEY] !== "boolean") {
    initialState[SNAPSTACK_ENABLED_STORAGE_KEY] = details.reason === "install" ? false : true;
  }
  await chrome.storage.local.set(initialState);
  const tab = await activeTab();
  if (tab?.id) void ensureContentInTab(tab.id);
});

chrome.runtime.onStartup.addListener(() => {
  void activeTab().then((tab) => {
    if (tab?.id) return ensureContentInTab(tab.id);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncStackToTab(tabId);
  void chrome.tabs.get(tabId).then(async (tab) => {
    await updateActionTitle(tab);
    await updateSiteToggleMenu(tab);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isSupportedPage(tab.url)) {
    void ensureContentInTab(tabId);
  }
  if (changeInfo.url || changeInfo.status === "complete") {
    void updateActionTitle(tab);
    if (tab.active) void updateSiteToggleMenu(tab);
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  void chrome.tabs.query({ active: true, windowId }).then(([tab]) => {
    if (tab?.id) return syncStackToTab(tab.id);
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-region") {
    void beginCaptureInActiveTab();
    return;
  }
  if (command === "toggle-snapstack") {
    void (async () => {
      const tab = await activeTab();
      if (!tab) return;
      const nextEnabled = !await getSnapStackEnabled();
      if (nextEnabled && tab.id) await ensureContentInTab(tab.id);
      await setSiteEnabled(tab, nextEnabled);
    })();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === SITE_TOGGLE_MENU_ID) {
    void setSiteEnabled(tab, Boolean(info.checked));
    return;
  }
  if (info.menuItemId === SAVE_IMAGE_MENU_ID) {
    void saveContextImage(info, tab).catch((error) => {
      if (!tab.id) return;
      void showToastInTab(
        tab.id,
        error instanceof Error ? error.message : "The image could not be saved to SnapStack."
      );
    });
  }
});

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse: (response: ExtensionResponse) => void) => {
    void (async () => {
      try {
        switch (message.type) {
          case "GET_STATE":
            sendResponse({
              ok: true,
              data: await getState(sender.tab?.url ?? (await activeTab())?.url)
            });
            return;
          case "GET_SITE_STATE":
            sendResponse({
              ok: true,
              data: await getSiteState(sender.tab?.url ?? (await activeTab())?.url)
            });
            return;
          case "GET_CAPTURE": {
            const item = await getCaptureItem(message.id);
            if (!item) throw new Error("This screenshot is no longer in your stack.");
            sendResponse({ ok: true, data: item });
            return;
          }
          case "GET_CAPTURES":
            sendResponse({ ok: true, data: await getCaptureItems() });
            return;
          case "CAPTURE_VISIBLE": {
            const windowId = sender.tab?.windowId;
            if (windowId === undefined) throw new Error("Screenshot capture must start from a webpage.");
            const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
              format: "jpeg",
              quality: 92
            });
            prunePendingScreenshots();
            const token = crypto.randomUUID();
            pendingScreenshots.set(token, { dataUrl, createdAt: Date.now() });
            sendResponse({ ok: true, data: { token } });
            return;
          }
          case "ADD_CAPTURE": {
            const pendingScreenshot = pendingScreenshots.get(message.screenshotToken);
            pendingScreenshots.delete(message.screenshotToken);
            if (!pendingScreenshot) {
              throw new Error("The screenshot expired before SnapStack could save it. Please try again.");
            }
            const cropped = await cropCapturedScreenshot(
              pendingScreenshot.dataUrl,
              message.rect,
              message.viewportWidth,
              message.viewportHeight
            );
            const item: CaptureItem = {
              ...cropped,
              sourceTitle: message.sourceTitle,
              sourceUrl: message.sourceUrl,
              id: crypto.randomUUID(),
              capturedAt: Date.now()
            };
            sendResponse({ ok: true, data: await addCaptureToStack(item) });
            return;
          }
          case "REMOVE_CAPTURE":
            await removeCaptureFromStack(message.id);
            sendResponse({ ok: true });
            return;
          case "MOVE_CAPTURE":
            await moveCaptureInStack(message.id, message.direction);
            sendResponse({ ok: true });
            return;
          case "CLEAR_STACK":
            sendResponse({ ok: true, data: await clearStackForUndo() });
            return;
          case "RESTORE_CLEARED_STACK":
            sendResponse({ ok: true, data: await restoreClearedStack(message.items) });
            return;
          case "COMMIT_CLEARED_STACK":
            await commitClearedStack(message.ids);
            sendResponse({ ok: true });
            return;
          case "SET_ACTIVE_SITE_ENABLED": {
            const tab = sender.tab ?? await activeTab();
            if (!tab) throw new Error("No active tab is available.");
            await setSiteEnabled(tab, message.enabled);
            sendResponse({
              ok: true,
              data: message.includeItems === false
                ? await getSiteState(tab.url)
                : await getState(tab.url)
            });
            return;
          }
          case "SET_SITE_DISABLED": {
            const tab = sender.tab ?? await activeTab();
            if (!tab) throw new Error("No active tab is available.");
            await setSiteDisabled(tab, message.disabled);
            sendResponse({ ok: true, data: await getSiteState(tab.url) });
            return;
          }
          case "SET_FLOATER_POSITION":
            await chrome.storage.local.set({
              [FLOATER_POSITION_STORAGE_KEY]: message.position
            });
            await broadcastToContent({
              type: "FLOATER_POSITION_CHANGED",
              position: message.position
            });
            sendResponse({ ok: true });
            return;
          case "OPEN_POPUP":
            await chrome.action.openPopup(
              sender.tab?.windowId === undefined
                ? undefined
                : { windowId: sender.tab.windowId }
            );
            sendResponse({ ok: true });
            return;
          case "START_CAPTURE_ACTIVE":
            await beginCaptureInActiveTab();
            sendResponse({ ok: true });
            return;
          case "GET_CONTEXT_IMAGE_URL":
            sendResponse({ ok: false, error: "Image lookup is only available inside a webpage." });
            return;
          case "SHOW_TOAST":
            sendResponse({ ok: true });
            return;
          case "PING":
            sendResponse({ ok: true });
            return;
          case "BEGIN_CAPTURE":
          case "STACK_UPDATED":
          case "SITE_ENABLED_CHANGED":
          case "FLOATER_POSITION_CHANGED":
            sendResponse({ ok: true });
            return;
        }
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Something went wrong."
        });
      }
    })();

    return true;
  }
);
