const ACTIVE_TAB_GRANT_KEY = "toolbarActiveTabGrant";
const OBSERVATION_WATCHES_KEY = "pageObservationWatches";
const automaticObservationRefreshes = new Set();

chrome.action.onClicked.addListener((tab) => {
    if (!Number.isInteger(tab?.id)) {
        console.error("Unable to open the AI Browser Assistant side panel: no tab ID was provided.");
        return;
    }

    const toolbarGrant = {
        tabId: tab.id,
        origin: parsePageUrl(tab.url)?.origin || null
    };
    chrome.storage.session.set({
        [ACTIVE_TAB_GRANT_KEY]: toolbarGrant
    }).then(() => chrome.runtime.sendMessage({
        type: "TOOLBAR_ACTIVE_TAB_GRANT_AVAILABLE",
        tabId: tab.id,
        origin: toolbarGrant.origin
    })).catch((error) => {
        console.debug("Toolbar activeTab grant notification was unavailable:", error.message);
    });
    chrome.sidePanel.open({ tabId: tab.id }).catch((error) => {
        console.error("Unable to open the AI Browser Assistant side panel:", error);
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "loading") {
        invalidateTabObservation(tabId);
    }
    if (changeInfo.url) {
        void refreshTabAccessForUrl(tabId);
    }
    if (changeInfo.status === "complete") {
        void refreshObservedTab(tabId);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    clearToolbarGrant(tabId);
    clearObservationWatch(tabId);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    void refreshObservedTab(activeInfo.tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GET_OBSERVATION_ACCESS") {
        getToolbarActiveTabGrant(message.tabId, message.origin)
            .then((activeTabGrant) => sendResponse({ activeTabGrant }))
            .catch((error) => {
                console.error("Unable to check toolbar activeTab access:", {
                    tabId: message.tabId,
                    origin: message.origin,
                    error: error.message
                });
                sendResponse({ activeTabGrant: false });
            });
        return true;
    }

    if (message?.type === "OBSERVE_ACTIVE_TAB") {
        observeActiveTab(message.tabId, message.expectedOrigin)
            .then((observation) => sendResponse({ ok: true, observation }))
            .catch((error) => {
                sendResponse({
                    ok: false,
                    requiresHostPermission: Boolean(error.requiresHostPermission),
                    error: error.message || "Unable to observe the active tab."
                });
            });

        return true;
    }

    if (message?.type === "NAVIGATE_ACTIVE_TAB") {
        navigateActiveTab(message.url)
            .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
            .catch((error) => {
                sendResponse({
                    ok: false,
                    error: error.message || "Unable to navigate the active tab."
                });
            });

        return true;
    }

    if (message?.type === "EXECUTE_APPROVED_CLICK") {
        executeApprovedClick(message, sender)
            .then((response) => sendResponse(response))
            .catch((error) => {
                sendResponse({
                    ok: false,
                    status: error.status || "failed",
                    error: error.message || "Unable to execute the approved click."
                });
            });
        return true;
    }

    if (message?.type !== "EXECUTE_SEARCH") {
        return false;
    }

    executeSearch(message)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => {
            sendResponse({
                ok: false,
                error: error.message || "Unable to execute the search."
            });
        });

    return true;
});

async function getToolbarActiveTabGrant(tabId, origin) {
    const stored = await chrome.storage.session.get(ACTIVE_TAB_GRANT_KEY);
    const grant = stored[ACTIVE_TAB_GRANT_KEY];
    return grant?.tabId === tabId && grant.origin === origin;
}

async function clearToolbarGrant(tabId) {
    const stored = await chrome.storage.session.get(ACTIVE_TAB_GRANT_KEY);
    if (stored[ACTIVE_TAB_GRANT_KEY]?.tabId === tabId) {
        await chrome.storage.session.remove(ACTIVE_TAB_GRANT_KEY);
    }
}

async function refreshTabAccessForUrl(tabId) {
    try {
        const [stored, tab] = await Promise.all([
            chrome.storage.session.get([ACTIVE_TAB_GRANT_KEY, OBSERVATION_WATCHES_KEY]),
            chrome.tabs.get(tabId)
        ]);
        const currentUrl = parsePageUrl(tab.url);
        const grant = stored[ACTIVE_TAB_GRANT_KEY];
        if (grant?.tabId === tabId && grant.origin !== currentUrl?.origin) {
            await chrome.storage.session.remove(ACTIVE_TAB_GRANT_KEY);
        }

        const watches = stored[OBSERVATION_WATCHES_KEY] || {};
        const watch = watches[tabId];
        if (watch && watch.origin !== currentUrl?.origin) {
            delete watches[tabId];
            await chrome.storage.session.set({ [OBSERVATION_WATCHES_KEY]: watches });
            await notifySidePanel({
                type: "PAGE_OBSERVATION_FAILED",
                tabId,
                error: "The active website changed. Click Observe active page to observe the new website."
            });
        }
    } catch (error) {
        console.error("Unable to refresh page access after navigation", {
            tabId,
            error: error.message
        });
    }
}

async function setObservationWatch(tabId, origin) {
    const stored = await chrome.storage.session.get(OBSERVATION_WATCHES_KEY);
    const watches = stored[OBSERVATION_WATCHES_KEY] || {};
    watches[tabId] = { origin };
    await chrome.storage.session.set({ [OBSERVATION_WATCHES_KEY]: watches });
}

async function clearObservationWatch(tabId) {
    const stored = await chrome.storage.session.get(OBSERVATION_WATCHES_KEY);
    const watches = stored[OBSERVATION_WATCHES_KEY] || {};
    if (watches[tabId]) {
        delete watches[tabId];
        await chrome.storage.session.set({ [OBSERVATION_WATCHES_KEY]: watches });
    }
}

function invalidateTabObservation(tabId) {
    chrome.tabs.sendMessage(tabId, { type: "INVALIDATE_SEARCH_TARGETS" })
        .catch((error) => {
            console.debug("Page target invalidation was unavailable:", {
                tabId,
                error: error.message
            });
        });
    notifySidePanel({
        type: "PAGE_OBSERVATION_INVALIDATED",
        tabId
    });
}

async function refreshObservedTab(tabId) {
    if (automaticObservationRefreshes.has(tabId)) {
        return;
    }

    automaticObservationRefreshes.add(tabId);
    try {
        const [stored, activeTab] = await Promise.all([
            chrome.storage.session.get(OBSERVATION_WATCHES_KEY),
            chrome.tabs.get(tabId)
        ]);
        const watch = stored[OBSERVATION_WATCHES_KEY]?.[tabId];
        if (!watch || activeTab.active === false) {
            return;
        }

        const pageUrl = parsePageUrl(activeTab.url);
        if (!pageUrl || pageUrl.origin !== watch.origin) {
            await clearObservationWatch(tabId);
            await notifySidePanel({
                type: "PAGE_OBSERVATION_FAILED",
                tabId,
                error: "This browser page cannot be observed. Click Observe active page on a regular HTTP or HTTPS website."
            });
            return;
        }

        const hasOriginPermission = await chrome.permissions.contains({
            origins: [`${pageUrl.origin}/*`]
        });
        const hasActiveTabGrant = await getToolbarActiveTabGrant(tabId, pageUrl.origin);
        if (!hasOriginPermission && !hasActiveTabGrant) {
            await notifySidePanel({
                type: "PAGE_OBSERVATION_FAILED",
                tabId,
                error: `Access to ${pageUrl.hostname} is not available for automatic refresh. Click Observe active page to grant access.`
            });
            return;
        }

        const observation = await observeActiveTab(tabId, pageUrl.origin);
        if (observation.url !== activeTab.url) {
            throw new Error("The webpage changed while its observation was refreshing.");
        }
        await notifySidePanel({
            type: "PAGE_OBSERVATION_UPDATED",
            tabId,
            observation
        });
    } catch (error) {
        console.error("Unable to refresh the loaded page observation", {
            tabId,
            error: error.message
        });
        await notifySidePanel({
            type: "PAGE_OBSERVATION_FAILED",
            tabId,
            error: `Unable to refresh webpage observation: ${error.message}`
        });
    } finally {
        automaticObservationRefreshes.delete(tabId);
    }
}

async function notifySidePanel(message) {
    try {
        await chrome.runtime.sendMessage(message);
    } catch (error) {
        console.debug("Side Panel observation notification was unavailable:", error.message);
    }
}

async function observeActiveTab(tabId, expectedOrigin) {
    const activeTab = Number.isInteger(tabId)
        ? await chrome.tabs.get(tabId)
        : await getActiveTab();
    if (activeTab.active === false) {
        throw new Error(
            "The active tab changed before observation could start. Click Observe active page again."
        );
    }

    const pageUrl = parsePageUrl(activeTab.url);

    if (!pageUrl) {
        throw new Error(
            "This browser page cannot be observed. Open a regular HTTP or HTTPS website and try again."
        );
    }

    if (expectedOrigin && pageUrl.origin !== expectedOrigin) {
        throw new Error(
            "The active tab navigated to a different website. Click Observe active page again."
        );
    }

    console.info("Injecting page observer", {
        tabId: activeTab.id,
        origin: pageUrl.origin
    });
    try {
        await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            files: ["content.js"]
        });
    } catch (error) {
        if (isHostPermissionError(error)) {
            console.warn("Page observer injection failed for host access", {
                tabId: activeTab.id,
                origin: pageUrl.origin,
                error: error.message
            });
            const permissionError = new Error(error.message);
            permissionError.requiresHostPermission = true;
            throw permissionError;
        }
        console.error("Page observer injection failed", {
            tabId: activeTab.id,
            origin: pageUrl.origin,
            error: error.message
        });
        throw error;
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
        type: "OBSERVE_PAGE"
    });

    if (!response?.observation) {
        throw new Error(response?.error || "The page did not return an observation.");
    }

    await setObservationWatch(activeTab.id, pageUrl.origin);
    return response.observation;
}

function parsePageUrl(value) {
    if (typeof value !== "string") {
        return null;
    }

    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }

    if (!["http:", "https:"].includes(url.protocol)) {
        return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (
        hostname === "chrome.google.com" && url.pathname.startsWith("/webstore") ||
        hostname === "chromewebstore.google.com"
    ) {
        return null;
    }

    return url;
}

function isHostPermissionError(error) {
    return /cannot access contents of the page|must request permission to access the respective host/i
        .test(error?.message || "");
}

async function navigateActiveTab(url) {
    const validatedUrl = validateWebsiteUrl(url);
    const activeTab = await getActiveTab();
    return chrome.tabs.update(activeTab.id, { url: validatedUrl });
}

function validateWebsiteUrl(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("The backend returned an invalid website URL.");
    }

    let url;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error("The backend returned an invalid website URL.");
    }

    if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
    ) {
        throw new Error("Only valid HTTP or HTTPS website URLs can be opened.");
    }

    return url.href;
}

async function executeSearch(message) {
    const activeTab = await getActiveTab();

    await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ["content.js"]
    });

    const response = await chrome.tabs.sendMessage(activeTab.id, {
        type: "EXECUTE_SEARCH",
        query: message.query,
        expectedUrl: message.expectedUrl,
        inputTargetId: message.inputTargetId,
        submitTargetId: message.submitTargetId
    });

    if (!response?.ok || !response.result) {
        throw new Error(response?.error || "The page rejected the search action.");
    }

    return response.result;
}

async function executeApprovedClick(message, sender) {
    if (
        sender?.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL("sidepanel.html")
    ) {
        throw clickExecutionError("rejected", "Approved clicks may only be requested by the Side Panel.");
    }

    const targetId = message.targetId;
    if (
        typeof targetId !== "string" ||
        !/^target-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(targetId)
    ) {
        throw clickExecutionError("rejected", "The approved click target ID is invalid.");
    }
    if (
        !Number.isInteger(message.tabId) ||
        !Number.isFinite(message.approvalExpiresAt) ||
        Date.now() >= message.approvalExpiresAt ||
        message.approvalExpiresAt > Date.now() + 4 * 60 * 1000
    ) {
        throw clickExecutionError("rejected", "The click approval is invalid or expired.");
    }

    const expectedUrl = parsePageUrl(message.expectedUrl);
    const supportedTypes = new Set(["a", "link", "button", "tab", "input (button)"]);
    if (
        !expectedUrl ||
        expectedUrl.href !== message.expectedUrl ||
        !supportedTypes.has(message.expectedElementType) ||
        typeof message.expectedElementText !== "string" ||
        message.expectedElementText.length > 200 ||
        (message.expectedHref !== null && typeof message.expectedHref !== "string")
    ) {
        throw clickExecutionError("rejected", "The approved click metadata is invalid.");
    }
    const expectedLink = message.expectedElementType === "a" ||
        message.expectedElementType === "link" ||
        message.expectedHref !== null;
    if (expectedLink) {
        if (!isSafeClickHref(message.expectedHref)) {
            throw clickExecutionError("rejected", "The approved link destination is not safe HTTP or HTTPS.");
        }
    } else if (message.expectedHref !== null) {
        throw clickExecutionError("rejected", "The approved non-link target contains an unexpected destination.");
    }

    const [activeTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
    });
    if (
        activeTab?.id !== message.tabId ||
        activeTab.url !== message.expectedUrl
    ) {
        throw clickExecutionError("rejected", "The approved click no longer targets the active page.");
    }

    const origin = expectedUrl.origin;
    const hasOriginPermission = await chrome.permissions.contains({
        origins: [`${origin}/*`]
    });
    const hasActiveTabGrant = hasOriginPermission
        ? false
        : await getToolbarActiveTabGrant(activeTab.id, origin);
    if (!hasOriginPermission && !hasActiveTabGrant) {
        throw clickExecutionError("rejected", "The extension no longer has access to this page.");
    }

    const [stillActiveTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
    });
    if (
        stillActiveTab?.id !== message.tabId ||
        stillActiveTab.url !== message.expectedUrl
    ) {
        throw clickExecutionError("rejected", "The active page changed before the click was sent.");
    }

    let readiness;
    try {
        readiness = await chrome.tabs.sendMessage(activeTab.id, {
            type: "PING_CLICK_EXECUTOR"
        });
    } catch {
        throw clickExecutionError("failed", "The page click executor is unavailable. No click was sent.");
    }
    if (!readiness?.ok) {
        throw clickExecutionError("failed", "The page click executor is unavailable. No click was sent.");
    }

    const [finalActiveTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
    });
    if (
        finalActiveTab?.id !== message.tabId ||
        finalActiveTab.url !== message.expectedUrl
    ) {
        throw clickExecutionError("rejected", "The active page changed before the click was sent.");
    }

    let response;
    try {
        response = await chrome.tabs.sendMessage(activeTab.id, {
            type: "EXECUTE_APPROVED_CLICK",
            targetId,
            expectedUrl: message.expectedUrl,
            expectedElementType: message.expectedElementType,
            expectedElementText: message.expectedElementText,
            expectedHref: message.expectedHref,
            approvalExpiresAt: message.approvalExpiresAt
        });
    } catch {
        return {
            ok: true,
            result: {
                status: "dispatched",
                uncertain: true,
                message: "The page changed or disconnected before responding. The click may have been dispatched; do not retry automatically."
            }
        };
    }

    if (response?.ok && response.result?.status === "dispatched") {
        return { ok: true, result: response.result };
    }
    return {
        ok: false,
        status: "rejected",
        error: response?.error || "The page rejected the approved click."
    };
}

function clickExecutionError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function isSafeClickHref(value) {
    if (typeof value !== "string") {
        return false;
    }

    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) &&
            Boolean(url.hostname) &&
            !url.username &&
            !url.password;
    } catch {
        return false;
    }
}

async function getActiveTab() {
    const [activeTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
    });

    if (!activeTab?.id) {
        throw new Error("No active browser tab was found.");
    }

    return activeTab;
}
