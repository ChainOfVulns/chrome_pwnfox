importScripts("config.js", "icon.js", "cookies.js");

const STORAGE_STATE_KEY = "pwnfoxContainerState";
const STORAGE_TABS_KEY = "pwnfoxTabContainers";

const state = {
    initialized: false,
    initPromise: null,
    cfg: { ...defaultConfig },
    containers: {},
    tabContainers: {}
};

function makeDefaultContainers() {
    const out = {};
    for (const color of CONTAINER_COLORS) {
        out[color] = {
            namespace: `${color}_1`,
            epoch: 1,
            cookies: {}
        };
    }
    return out;
}

/* Persistence helpers (coalesced writes) */
let saveTimer = null;
let pendingSaveContainers = false;
let pendingSaveTabs = false;

function schedulePersist({ containers = false, tabs = false } = {}) {
    if (containers) pendingSaveContainers = true;
    if (tabs) pendingSaveTabs = true;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
        saveTimer = null;
        const payload = {};
        if (pendingSaveContainers) {
            pendingSaveContainers = false;
            payload[STORAGE_STATE_KEY] = state.containers;
        }
        if (pendingSaveTabs) {
            pendingSaveTabs = false;
            payload[STORAGE_TABS_KEY] = state.tabContainers;
        }
        if (Object.keys(payload).length > 0) {
            await chrome.storage.local.set(payload);
        }
    }, 50);
}

async function flushPersist() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    const payload = {};
    if (pendingSaveContainers) {
        pendingSaveContainers = false;
        payload[STORAGE_STATE_KEY] = state.containers;
    }
    if (pendingSaveTabs) {
        pendingSaveTabs = false;
        payload[STORAGE_TABS_KEY] = state.tabContainers;
    }
    if (Object.keys(payload).length > 0) {
        await chrome.storage.local.set(payload);
    }
}

/* Serialized / coalesced DNR rule sync */
let dnrSyncInFlight = null;
let dnrSyncDirty = false;
let dnrNextWaiters = [];
let knownSessionRuleIds = null;

function scheduleDnrSync() {
    if (dnrSyncInFlight) {
        dnrSyncDirty = true;
        return new Promise((resolve) => {
            dnrNextWaiters.push(resolve);
        });
    }
    dnrSyncInFlight = (async () => {
        try {
            do {
                dnrSyncDirty = false;
                const waiters = dnrNextWaiters;
                dnrNextWaiters = [];
                await performDnrSync();
                for (const resolve of waiters) resolve();
            } while (dnrSyncDirty);
        } finally {
            dnrSyncInFlight = null;
            const remaining = dnrNextWaiters;
            dnrNextWaiters = [];
            for (const resolve of remaining) resolve();
        }
    })();
    return dnrSyncInFlight;
}

async function performDnrSync() {
    if (knownSessionRuleIds === null) {
        const existing = await chrome.declarativeNetRequest.getSessionRules();
        knownSessionRuleIds = existing.map(r => r.id);
    }

    const tabsByColor = {};
    for (const color of CONTAINER_COLORS) {
        tabsByColor[color] = [];
    }
    for (const [tabIdStr, color] of Object.entries(state.tabContainers)) {
        const tabId = Number(tabIdStr);
        if (Number.isInteger(tabId) && tabId >= 0 && tabsByColor[color]) {
            tabsByColor[color].push(tabId);
        }
    }

    const addRules = [];
    let nextRuleId = 1;
    const includeColorHeader = Boolean(state.cfg.enabled && state.cfg.addContainerHeader);

    for (const color of CONTAINER_COLORS) {
        const tabIds = tabsByColor[color];
        if (!tabIds || tabIds.length === 0) continue;

        const container = state.containers[color];
        const reqHeaders = [{ header: "cookie", operation: "remove" }];
        if (includeColorHeader) {
            reqHeaders.push({
                header: "x-pwnfox-color",
                operation: "set",
                value: BURP_COLOR_MAP[color] || color
            });
        }

        // Baseline: isolate cookies & strip Set-Cookie, optionally add X-PwnFox-Color
        addRules.push({
            id: nextRuleId++,
            priority: 1,
            action: {
                type: "modifyHeaders",
                requestHeaders: reqHeaders,
                responseHeaders: [{ header: "set-cookie", operation: "remove" }]
            },
            condition: {
                tabIds,
                resourceTypes: PwnFoxCookies.ALL_RESOURCE_TYPES
            }
        });

        // Document metadata via Server-Timing so MAIN world detects container synchronously at document_start
        addRules.push({
            id: nextRuleId++,
            priority: 2,
            action: {
                type: "modifyHeaders",
                responseHeaders: [
                    {
                        header: "server-timing",
                        operation: "append",
                        value: `pwnfox;desc="${color}:${container.namespace}"`
                    }
                ]
            },
            condition: {
                tabIds,
                resourceTypes: ["main_frame", "sub_frame"]
            }
        });

        // Container cookie rules
        const specs = PwnFoxCookies.buildCookieDnrSpecs(container.cookies);
        for (const spec of specs) {
            if (!spec.cookieHeader) continue;

            addRules.push({
                id: nextRuleId++,
                priority: spec.priority,
                action: {
                    type: "modifyHeaders",
                    requestHeaders: [
                        { header: "cookie", operation: "set", value: spec.cookieHeader }
                    ]
                },
                condition: {
                    tabIds,
                    regexFilter: spec.regexFilter,
                    resourceTypes: PwnFoxCookies.ALL_RESOURCE_TYPES
                }
            });

            if (spec.encodedNonHttpOnly) {
                addRules.push({
                    id: nextRuleId++,
                    priority: spec.priority,
                    action: {
                        type: "modifyHeaders",
                        responseHeaders: [
                            {
                                header: "server-timing",
                                operation: "append",
                                value: `pwnfox-ck;desc="${spec.encodedNonHttpOnly}"`
                            }
                        ]
                    },
                    condition: {
                        tabIds,
                        regexFilter: spec.regexFilter,
                        resourceTypes: ["main_frame", "sub_frame"]
                    }
                });
            }
        }
    }

    const removeRuleIds = knownSessionRuleIds;
    const newRuleIds = addRules.map(r => r.id);
    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds,
            addRules
        });
        knownSessionRuleIds = newRuleIds;
    } catch {
        // Re-sync rule IDs from Chrome if out of sync, and filter invalid regex rules if needed
        const existing = await chrome.declarativeNetRequest.getSessionRules();
        knownSessionRuleIds = existing.map(r => r.id);
        try {
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: knownSessionRuleIds,
                addRules
            });
            knownSessionRuleIds = newRuleIds;
        } catch {
            const safeRules = [];
            for (const rule of addRules) {
                if (rule.condition?.regexFilter) {
                    try {
                        const check = await chrome.declarativeNetRequest.isRegexSupported({
                            regex: rule.condition.regexFilter
                        });
                        if (!check?.isSupported) continue;
                    } catch {
                        continue;
                    }
                }
                safeRules.push(rule);
            }
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: knownSessionRuleIds,
                addRules: safeRules
            });
            knownSessionRuleIds = safeRules.map(r => r.id);
        }
    }
}

/* Proxy & Icon */
async function applyProxySettings() {
    if (state.cfg.enabled && state.cfg.useBurpProxy) {
        const host = String(state.cfg.burpProxyHost || "127.0.0.1").trim() || "127.0.0.1";
        let port = parseInt(state.cfg.burpProxyPort, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            port = 8080;
        }
        await chrome.proxy.settings.set({
            value: {
                mode: "fixed_servers",
                rules: {
                    singleProxy: {
                        scheme: "http",
                        host,
                        port
                    },
                    bypassList: ["<-loopback>"]
                }
            },
            scope: "regular"
        });
    } else {
        await chrome.proxy.settings.clear({ scope: "regular" });
    }
}

async function applyIcon() {
    try {
        const dotColor = state.cfg.enabled ? "#00ff00" : "#ff0000";
        const imageData = createIconImageData(dotColor, 48);
        await chrome.action.setIcon({ imageData });
    } catch {
        // Ignore icon errors in headless/restricted environments
    }
}

/* Initialization */
async function ensureInitialized() {
    if (state.initialized) return;
    if (state.initPromise) return state.initPromise;

    state.initPromise = (async () => {
        const stored = await chrome.storage.local.get([
            ...Object.keys(defaultConfig),
            STORAGE_STATE_KEY,
            STORAGE_TABS_KEY
        ]);

        state.cfg = {
            ...defaultConfig,
            ...Object.fromEntries(
                Object.keys(defaultConfig)
                    .filter(k => stored[k] !== undefined)
                    .map(k => [k, stored[k]])
            )
        };

        const defaults = makeDefaultContainers();
        const savedContainers = stored[STORAGE_STATE_KEY] || {};
        for (const color of CONTAINER_COLORS) {
            const c = savedContainers[color];
            state.containers[color] = {
                namespace: c?.namespace || defaults[color].namespace,
                epoch: c?.epoch || 1,
                cookies: c?.cookies && typeof c.cookies === "object" ? c.cookies : {}
            };
            PwnFoxCookies.pruneExpiredCookies(state.containers[color].cookies);
        }

        const savedTabs = stored[STORAGE_TABS_KEY] || {};
        const openTabs = await chrome.tabs.query({});
        const openTabIds = new Set(openTabs.map(t => t.id));
        const cleanTabs = {};

        for (const [tabIdStr, color] of Object.entries(savedTabs)) {
            const tabId = Number(tabIdStr);
            if (openTabIds.has(tabId) && CONTAINER_COLORS.includes(color)) {
                cleanTabs[tabId] = color;
            }
        }

        // Recover container association from PwnFox-* Chrome Tab Groups (e.g. after browser session restore)
        try {
            const groups = await chrome.tabGroups.query({});
            const groupColorById = {};
            for (const g of groups) {
                if (g.title && g.title.startsWith("PwnFox-")) {
                    const color = g.title.slice("PwnFox-".length);
                    if (CONTAINER_COLORS.includes(color)) {
                        groupColorById[g.id] = color;
                    }
                }
            }
            for (const tab of openTabs) {
                if (tab.groupId !== undefined && tab.groupId !== -1 && groupColorById[tab.groupId]) {
                    cleanTabs[tab.id] = groupColorById[tab.groupId];
                }
            }
        } catch {
            // tabGroups might be unavailable in rare contexts
        }

        state.tabContainers = cleanTabs;
        state.initialized = true;

        schedulePersist({ containers: true, tabs: true });
        await Promise.all([
            applyIcon(),
            applyProxySettings(),
            scheduleDnrSync()
        ]);
    })();

    return state.initPromise;
}

/* Tab Grouping */
const groupAssignQueues = new Map();

function assignTabToGroup(tabId, windowId, color) {
    const queueKey = `${windowId}:${color}`;
    const prev = groupAssignQueues.get(queueKey) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
        try {
            const title = `PwnFox-${color}`;
            const groupColor = TAB_GROUP_COLOR_MAP[color] || "blue";
            const existingGroups = await chrome.tabGroups.query({ windowId, title });
            if (existingGroups.length > 0) {
                await chrome.tabs.group({ tabIds: [tabId], groupId: existingGroups[0].id });
            } else {
                const groupId = await chrome.tabs.group({
                    createProperties: { windowId },
                    tabIds: [tabId]
                });
                await chrome.tabGroups.update(groupId, { title, color: groupColor });
            }
        } catch {
            // Popup windows or closing tabs cannot be grouped; isolation still applies via tabId
        }
    });
    groupAssignQueues.set(queueKey, next);
    next.finally(() => {
        if (groupAssignQueues.get(queueKey) === next) {
            groupAssignQueues.delete(queueKey);
        }
    });
    return next;
}

let pendingCreateColor = null;
let createTabQueue = Promise.resolve();

async function createContainerTab(color, url = undefined) {
    await ensureInitialized();
    if (!CONTAINER_COLORS.includes(color)) {
        throw new Error(`Unknown container color: ${color}`);
    }
    const tab = await (createTabQueue = createTabQueue.catch(() => {}).then(async () => {
        pendingCreateColor = color;
        try {
            const createOpts = { active: true };
            if (url) createOpts.url = "about:blank";
            return await chrome.tabs.create(createOpts);
        } finally {
            pendingCreateColor = null;
        }
    }));

    state.tabContainers[tab.id] = color;
    schedulePersist({ tabs: true });
    await Promise.all([
        scheduleDnrSync(),
        assignTabToGroup(tab.id, tab.windowId, color)
    ]);
    if (url) {
        await chrome.tabs.update(tab.id, { url });
    }
    return tab;
}

async function clearContainer(color) {
    await ensureInitialized();
    if (!CONTAINER_COLORS.includes(color)) return;
    const container = state.containers[color];
    container.cookies = {};
    container.epoch = (container.epoch || 1) + 1;
    container.namespace = `${color}_${container.epoch}`;

    schedulePersist({ containers: true });
    await flushPersist();
    await scheduleDnrSync();

    // Notify open tabs in this container so MAIN world switches namespace & clears cookie cache
    for (const [tabIdStr, tabColor] of Object.entries(state.tabContainers)) {
        if (tabColor !== color) continue;
        const tabId = Number(tabIdStr);
        chrome.tabs.sendMessage(tabId, {
            type: "CONTAINER_CLEARED",
            color,
            namespace: container.namespace
        }).catch(() => {});
    }
}

/* Cookie sync helper */
function resolveHttpUrl(url, fallbackOrigin) {
    if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
        return url;
    }
    if (fallbackOrigin && (fallbackOrigin.startsWith("http://") || fallbackOrigin.startsWith("https://"))) {
        return `${fallbackOrigin}/`;
    }
    return null;
}

function getNonHttpOnlyPairsForUrl(color, url) {
    const container = state.containers[color];
    if (!container || !url) return [];
    return PwnFoxCookies.getMatchingCookies(container.cookies, url, { forDocumentCookie: true })
        .map(c => [c.name, c.value]);
}

function domainsOverlap(hostA, hostB, affectedDomains) {
    if (hostA === hostB) return true;
    if (PwnFoxCookies.domainMatches(hostA, hostB, false)) return true;
    if (PwnFoxCookies.domainMatches(hostB, hostA, false)) return true;
    if (affectedDomains) {
        for (const d of affectedDomains) {
            if (PwnFoxCookies.domainMatches(hostA, d, false)) return true;
        }
    }
    return false;
}

function resolveEffectiveFrameUrl(frame, frameMap, tabUrl) {
    let cur = frame;
    const seen = new Set();
    while (cur && !seen.has(cur.frameId)) {
        seen.add(cur.frameId);
        if (cur.url && (cur.url.startsWith("http://") || cur.url.startsWith("https://"))) {
            return cur.url;
        }
        if (cur.parentFrameId === undefined || cur.parentFrameId < 0) break;
        cur = frameMap.get(cur.parentFrameId);
    }
    if (tabUrl && (tabUrl.startsWith("http://") || tabUrl.startsWith("https://"))) {
        return tabUrl;
    }
    return null;
}

function notifyContainerTabsCookiesUpdated(color, changedUrl, affectedDomains = null) {
    let changedHost = null;
    try {
        changedHost = new URL(changedUrl).hostname.toLowerCase();
    } catch {
        return;
    }
    for (const [tabIdStr, tabColor] of Object.entries(state.tabContainers)) {
        if (tabColor !== color) continue;
        const tabId = Number(tabIdStr);
        Promise.all([
            chrome.tabs.get(tabId).catch(() => null),
            chrome.webNavigation.getAllFrames({ tabId }).catch(() => null)
        ]).then(([tab, frames]) => {
            if (!tab) return;
            const frameList = Array.isArray(frames) && frames.length > 0
                ? frames
                : (tab.url ? [{ frameId: 0, parentFrameId: -1, url: tab.url }] : []);
            const frameMap = new Map(frameList.map(f => [f.frameId, f]));

            for (const frame of frameList) {
                const effectiveUrl = resolveEffectiveFrameUrl(frame, frameMap, tab.url);
                if (!effectiveUrl) continue;
                try {
                    const frameHost = new URL(effectiveUrl).hostname.toLowerCase();
                    if (!domainsOverlap(frameHost, changedHost, affectedDomains)) continue;
                    const pairs = getNonHttpOnlyPairsForUrl(color, effectiveUrl);
                    chrome.tabs.sendMessage(tabId, {
                        type: "COOKIES_UPDATED",
                        color,
                        pairs
                    }, { frameId: frame.frameId }).catch(() => {});
                } catch {
                    // Ignore non-HTTP frame URLs
                }
            }
        }).catch(() => {});
    }
}

/* Redirect race guard for 3xx main_frame Set-Cookie -> immediate redirect in MV3 */
const redirectRaceTracker = new Map();

/* WebRequest Set-Cookie capture */
function handleHeadersReceived(details) {
    if (details.tabId < 0) return;

    let deferredTracker = null;
    if (!state.initialized && details.type === "main_frame" && details.statusCode >= 300 && details.statusCode < 400) {
        const headers = details.responseHeaders || [];
        let hasSetCookie = false;
        let locationHeader = null;
        for (const h of headers) {
            const lname = h.name.toLowerCase();
            if (lname === "set-cookie" && h.value) hasSetCookie = true;
            else if (lname === "location" && h.value) locationHeader = h.value;
        }
        if (hasSetCookie && locationHeader) {
            try {
                const resolvedRedirect = new URL(locationHeader, details.url).href;
                let resolveSync;
                const syncPromise = new Promise((r) => { resolveSync = r; });
                deferredTracker = {
                    tabId: details.tabId,
                    redirectUrl: resolvedRedirect,
                    syncDone: false,
                    syncCompletedAt: Infinity,
                    syncPromise,
                    resolveSync,
                    retrying: false
                };
                redirectRaceTracker.set(details.requestId, deferredTracker);
            } catch {
                // ignore invalid redirect
            }
        }
    }

    const process = () => {
        const color = state.tabContainers[details.tabId];
        if (!color) {
            if (deferredTracker) {
                redirectRaceTracker.delete(details.requestId);
                deferredTracker.resolveSync(false);
            }
            return;
        }

        const headers = details.responseHeaders || [];
        let changed = false;
        let locationHeader = null;
        const affectedDomains = new Set();
        const container = state.containers[color];

        for (const h of headers) {
            const lname = h.name.toLowerCase();
            if (lname === "location" && h.value) {
                locationHeader = h.value;
            }
            if (lname !== "set-cookie" || !h.value) continue;
            const parsed = PwnFoxCookies.parseCookieString(h.value, details.url, { fromDocumentCookie: false });
            if (parsed && PwnFoxCookies.applyCookieToJar(container.cookies, parsed, { fromDocumentCookie: false })) {
                changed = true;
                affectedDomains.add(parsed.domain);
            }
        }

        if (changed) {
            const syncPromise = scheduleDnrSync();
            schedulePersist({ containers: true });
            notifyContainerTabsCookiesUpdated(color, details.url, affectedDomains);

            if (deferredTracker) {
                syncPromise.then(() => {
                    deferredTracker.syncDone = true;
                    deferredTracker.syncCompletedAt = Date.now();
                    deferredTracker.resolveSync(true);
                });
            } else if (
                details.type === "main_frame" &&
                details.statusCode >= 300 &&
                details.statusCode < 400 &&
                locationHeader
            ) {
                let resolvedRedirect = null;
                try {
                    resolvedRedirect = new URL(locationHeader, details.url).href;
                } catch {
                    resolvedRedirect = null;
                }
                if (resolvedRedirect) {
                    const tracker = {
                        tabId: details.tabId,
                        redirectUrl: resolvedRedirect,
                        syncDone: false,
                        syncCompletedAt: Infinity,
                        syncPromise: syncPromise.then(() => true),
                        retrying: false
                    };
                    syncPromise.then(() => {
                        tracker.syncDone = true;
                        tracker.syncCompletedAt = Date.now();
                    });
                    redirectRaceTracker.set(details.requestId, tracker);
                }
            }
        } else if (deferredTracker) {
            redirectRaceTracker.delete(details.requestId);
            deferredTracker.resolveSync(false);
        }
    };

    if (state.initialized) {
        process();
    } else {
        ensureInitialized().then(process);
    }
}

chrome.webRequest.onHeadersReceived.addListener(
    handleHeadersReceived,
    { urls: ["<all_urls>"] },
    ["responseHeaders", "extraHeaders"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const tracker = redirectRaceTracker.get(details.requestId);
        if (!tracker || tracker.retrying) return;
        const reqTime = details.timeStamp || Date.now();
        if (!tracker.syncDone || tracker.syncCompletedAt >= reqTime - 1) {
            tracker.retrying = true;
            const targetUrl = tracker.redirectUrl;
            const tabId = tracker.tabId;
            redirectRaceTracker.delete(details.requestId);
            tracker.syncPromise.then((shouldRetry) => {
                if (shouldRetry !== false) {
                    chrome.tabs.update(tabId, { url: targetUrl }).catch(() => {});
                }
            });
        }
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["requestHeaders", "extraHeaders"]
);

function cleanupRedirectTracker(details) {
    redirectRaceTracker.delete(details.requestId);
}
chrome.webRequest.onCompleted.addListener(cleanupRedirectTracker, { urls: ["<all_urls>"], types: ["main_frame"] });
chrome.webRequest.onErrorOccurred.addListener(cleanupRedirectTracker, { urls: ["<all_urls>"], types: ["main_frame"] });

/* Tab Lifecycle Listeners */
chrome.tabs.onCreated.addListener(async (tab) => {
    const forcedColor = pendingCreateColor;
    await ensureInitialized();

    if (state.tabContainers[tab.id]) return;

    let inheritedColor = forcedColor || null;

    if (!inheritedColor && tab.groupId !== undefined && tab.groupId !== -1) {
        try {
            const group = await chrome.tabGroups.get(tab.groupId);
            if (group?.title && group.title.startsWith("PwnFox-")) {
                const c = group.title.slice("PwnFox-".length);
                if (CONTAINER_COLORS.includes(c)) inheritedColor = c;
            }
        } catch {
            // ignore
        }
    }

    if (inheritedColor) {
        state.tabContainers[tab.id] = inheritedColor;
        scheduleDnrSync();
        schedulePersist({ tabs: true });
        if (!forcedColor && tab.groupId === -1) {
            assignTabToGroup(tab.id, tab.windowId, inheritedColor);
        }
    }
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
    await ensureInitialized();
    const sourceColor = state.tabContainers[details.sourceTabId];
    if (!sourceColor || state.tabContainers[details.tabId]) return;

    state.tabContainers[details.tabId] = sourceColor;
    scheduleDnrSync();
    schedulePersist({ tabs: true });

    try {
        const newTab = await chrome.tabs.get(details.tabId);
        assignTabToGroup(newTab.id, newTab.windowId, sourceColor);
    } catch {
        // ignore
    }
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    await ensureInitialized();
    const color = state.tabContainers[removedTabId];
    if (!color) return;
    delete state.tabContainers[removedTabId];
    state.tabContainers[addedTabId] = color;
    scheduleDnrSync();
    schedulePersist({ tabs: true });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await ensureInitialized();
    if (state.tabContainers[tabId]) {
        delete state.tabContainers[tabId];
        scheduleDnrSync();
        schedulePersist({ tabs: true });
    }
});

/* Config change reactions */
chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== "local") return;
    await ensureInitialized();

    let proxyDirty = false;
    let iconDirty = false;
    let dnrDirty = false;

    for (const [key, { newValue }] of Object.entries(changes)) {
        if (!Object.prototype.hasOwnProperty.call(defaultConfig, key)) continue;
        state.cfg[key] = newValue ?? defaultConfig[key];

        if (key === "enabled") {
            iconDirty = true;
            proxyDirty = true;
            dnrDirty = true;
        } else if (key === "useBurpProxy" || key === "burpProxyHost" || key === "burpProxyPort") {
            proxyDirty = true;
        } else if (key === "addContainerHeader") {
            dnrDirty = true;
        }
    }

    if (iconDirty) await applyIcon();
    if (proxyDirty) await applyProxySettings();
    if (dnrDirty) await scheduleDnrSync();
});

/* Messages from content scripts & popup/settings */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        await ensureInitialized();

        if (msg?.type === "GET_TAB_CONTEXT") {
            const tabId = sender.tab?.id;
            const color = tabId !== undefined ? (state.tabContainers[tabId] || null) : null;
            if (!color) {
                sendResponse({ color: null, namespace: null, pairs: [] });
                return;
            }
            const container = state.containers[color];
            const url = resolveHttpUrl(msg.url || sender.url, sender.origin);
            const pairs = getNonHttpOnlyPairsForUrl(color, url);
            sendResponse({
                color,
                namespace: container.namespace,
                pairs
            });
            return;
        }

        if (msg?.type === "SET_DOCUMENT_COOKIE") {
            const tabId = sender.tab?.id;
            const color = tabId !== undefined ? state.tabContainers[tabId] : null;
            if (!color) {
                sendResponse({ ok: false });
                return;
            }
            const container = state.containers[color];
            const url = resolveHttpUrl(msg.url || sender.url, sender.origin);
            const parsed = url ? PwnFoxCookies.parseCookieString(msg.cookieString, url, { fromDocumentCookie: true }) : null;
            if (parsed) {
                const changed = PwnFoxCookies.applyCookieToJar(container.cookies, parsed, { fromDocumentCookie: true });
                if (changed) {
                    schedulePersist({ containers: true });
                    await scheduleDnrSync();
                    notifyContainerTabsCookiesUpdated(color, url, new Set([parsed.domain]));
                }
            }
            sendResponse({
                ok: true,
                pairs: getNonHttpOnlyPairsForUrl(color, url)
            });
            return;
        }

        if (msg?.type === "CREATE_CONTAINER_TAB") {
            const tab = await createContainerTab(msg.color, msg.url);
            sendResponse({ ok: true, tabId: tab.id });
            return;
        }

        if (msg?.type === "GET_STATUS") {
            const tabCounts = {};
            const cookieCounts = {};
            for (const c of CONTAINER_COLORS) {
                tabCounts[c] = 0;
                PwnFoxCookies.pruneExpiredCookies(state.containers[c].cookies);
                cookieCounts[c] = Object.keys(state.containers[c].cookies).length;
            }
            for (const c of Object.values(state.tabContainers)) {
                if (tabCounts[c] !== undefined) tabCounts[c]++;
            }
            let activeTabColor = null;
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab && state.tabContainers[activeTab.id]) {
                activeTabColor = state.tabContainers[activeTab.id];
            }
            sendResponse({
                config: state.cfg,
                tabCounts,
                cookieCounts,
                activeTabColor
            });
            return;
        }

        if (msg?.type === "CLEAR_CONTAINER") {
            await clearContainer(msg.color);
            sendResponse({ ok: true });
            return;
        }

        if (msg?.type === "CLEAR_ALL_CONTAINERS") {
            for (const c of CONTAINER_COLORS) {
                await clearContainer(c);
            }
            sendResponse({ ok: true });
            return;
        }

        sendResponse({ ok: false, error: "Unknown message type" });
    })().catch(err => {
        sendResponse({ ok: false, error: String(err) });
    });
    return true;
});

chrome.runtime.onStartup.addListener(() => {
    ensureInitialized();
});

chrome.runtime.onInstalled.addListener(() => {
    ensureInitialized();
});

ensureInitialized();
