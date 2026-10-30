const ACTIVE_TAB_GRANT_KEY = "toolbarActiveTabGrant";

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
    if (changeInfo.url) {
        clearToolbarGrant(tabId);
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    clearToolbarGrant(tabId);
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
        inputIndex: message.inputIndex,
        submitIndex: message.submitIndex,
        expectedInput: message.expectedInput,
        expectedSubmit: message.expectedSubmit
    });

    if (!response?.ok || !response.result) {
        throw new Error(response?.error || "The page rejected the search action.");
    }

    return response.result;
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
