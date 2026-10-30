chrome.action.onClicked.addListener((tab) => {
    if (!Number.isInteger(tab?.id)) {
        console.error("Unable to open the AI Browser Assistant side panel: no tab ID was provided.");
        return;
    }

    chrome.sidePanel.open({ tabId: tab.id }).catch((error) => {
        console.error("Unable to open the AI Browser Assistant side panel:", error);
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "OBSERVE_ACTIVE_TAB") {
        observeActiveTab()
            .then((observation) => sendResponse({ ok: true, observation }))
            .catch((error) => {
                sendResponse({
                    ok: false,
                    error: error.message || "Unable to observe the active tab."
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

async function observeActiveTab() {
    const activeTab = await getActiveTab();

    await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ["content.js"]
    });

    const response = await chrome.tabs.sendMessage(activeTab.id, {
        type: "OBSERVE_PAGE"
    });

    if (!response?.observation) {
        throw new Error(response?.error || "The page did not return an observation.");
    }

    return response.observation;
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
