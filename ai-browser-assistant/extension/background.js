chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((error) => {
        console.error("Unable to open the AI Browser Assistant side panel:", error);
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "OBSERVE_ACTIVE_TAB") {
        return false;
    }

    observeActiveTab()
        .then((observation) => sendResponse({ ok: true, observation }))
        .catch((error) => {
            sendResponse({
                ok: false,
                error: error.message || "Unable to observe the active tab."
            });
        });

    return true;
});

async function observeActiveTab() {
    const [activeTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
    });

    if (!activeTab?.id) {
        throw new Error("No active browser tab was found.");
    }

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
