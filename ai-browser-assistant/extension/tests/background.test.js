const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionPath = path.resolve(__dirname, "..");

function loadBackground({
    activeTab,
    scriptInjectionError,
    scriptInjectionErrorAfter,
    hostPermissionGranted = false,
    tabMessageHandler,
    tabMessageResponse = {
        observation: {
            title: "Test page",
            url: "https://example.test/"
        }
    }
}) {
    const toolbarClickListeners = [];
    const messageListeners = [];
    const tabUpdatedListeners = [];
    const tabRemovedListeners = [];
    const tabActivatedListeners = [];
    const pendingTimers = new Map();
    const calls = {
        panelOpen: [],
        scriptInjection: [],
        tabMessages: [],
        tabUpdates: [],
        runtimeMessages: [],
        sessionStorage: {},
        pendingTimers
    };
    let nextTimerId = 1;

    const chrome = {
        action: {
            onClicked: {
                addListener(listener) {
                    toolbarClickListeners.push(listener);
                }
            }
        },
        runtime: {
            id: "test-extension-id",
            onMessage: {
                addListener(listener) {
                    messageListeners.push(listener);
                }
            },
            sendMessage(message) {
                calls.runtimeMessages.push(message);
                return Promise.resolve();
            }
        },
        sidePanel: {
            open(options) {
                calls.panelOpen.push(options);
                return Promise.resolve();
            }
        },
        tabs: {
            onUpdated: {
                addListener(listener) {
                    tabUpdatedListeners.push(listener);
                }
            },
            onActivated: {
                addListener(listener) {
                    tabActivatedListeners.push(listener);
                }
            },
            onRemoved: {
                addListener(listener) {
                    tabRemovedListeners.push(listener);
                }
            },
            async query() {
                return activeTab.active === false ? [] : [activeTab];
            },
            async get(tabId) {
                assert.equal(tabId, activeTab.id);
                return { ...activeTab, active: activeTab.active ?? true };
            },
            async update(tabId, properties) {
                calls.tabUpdates.push({ tabId, properties });
                return { ...activeTab, ...properties };
            },
            async sendMessage(tabId, message) {
                calls.tabMessages.push({ tabId, message });
                if (message.type === "INVALIDATE_SEARCH_TARGETS") {
                    return { ok: true };
                }
                return tabMessageHandler
                    ? tabMessageHandler(tabId, message, calls.tabMessages.length)
                    : tabMessageResponse;
            }
        },
        storage: {
            session: {
                async get(key) {
                    if (Array.isArray(key)) {
                        return Object.fromEntries(
                            key.map(item => [item, calls.sessionStorage[item]])
                        );
                    }
                    return { [key]: calls.sessionStorage[key] };
                },
                async set(values) {
                    Object.assign(calls.sessionStorage, values);
                },
                async remove(key) {
                    delete calls.sessionStorage[key];
                }
            }
        },
        scripting: {
            async executeScript(options) {
                calls.scriptInjection.push(options);
                if (
                    scriptInjectionError ||
                    calls.scriptInjection.length > 1 && scriptInjectionErrorAfter
                ) {
                    throw new Error(scriptInjectionError || scriptInjectionErrorAfter);
                }
            }
        }
    };

    chrome.permissions = {
        async contains() {
            return hostPermissionGranted;
        }
    };

    const source = fs.readFileSync(path.join(extensionPath, "background.js"), "utf8");
    vm.runInNewContext(source, {
        chrome,
        console,
        URL,
        setTimeout(callback) {
            const timerId = nextTimerId++;
            pendingTimers.set(timerId, callback);
            return timerId;
        },
        clearTimeout(timerId) {
            pendingTimers.delete(timerId);
        }
    });

    return {
        calls,
        messageListeners,
        tabActivatedListeners,
        tabRemovedListeners,
        tabUpdatedListeners,
        toolbarClickListeners,
        async flushTimers() {
            while (pendingTimers.size) {
                const callbacks = Array.from(pendingTimers.values());
                pendingTimers.clear();
                callbacks.forEach(callback => callback());
                for (let turn = 0; turn < 4; turn += 1) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
        },
        runNextTimer() {
            const [timerId, callback] = pendingTimers.entries().next().value || [];
            if (callback) {
                pendingTimers.delete(timerId);
                callback();
            }
        }
    };
}

function sendRuntimeMessage(messageListeners, message) {
    return new Promise((resolve) => {
        const keepChannelOpen = messageListeners[0](message, {}, resolve);
        if (!keepChannelOpen) {
            resolve(undefined);
        }
    });
}

function sendContentMessage(messageListeners, message, sender) {
    return new Promise((resolve) => {
        const keepChannelOpen = messageListeners[0](message, sender, resolve);
        if (!keepChannelOpen) {
            resolve(undefined);
        }
    });
}

async function observeWatchedTab(messageListeners, tab) {
    const response = await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB",
        tabId: tab.id,
        expectedOrigin: new URL(tab.url).origin
    });
    assert.equal(response.ok, true);
}

function contentChangeSender(tab) {
    return {
        id: "test-extension-id",
        url: tab.url,
        frameId: 0,
        tab: { id: tab.id, url: tab.url }
    };
}

function pageContentChangedMessage(tab) {
    return {
        type: "PAGE_CONTENT_CHANGED",
        url: tab.url
    };
}

test("search execution forwards opaque target IDs to the content script", async () => {
    const activeTab = { id: 45, windowId: 7, url: "https://example.test/" };
    const targetIds = {
        inputTargetId: "target-00000000-0000-4000-8000-000000000001",
        submitTargetId: "target-00000000-0000-4000-8000-000000000002"
    };
    const { calls, messageListeners } = loadBackground({
        activeTab,
        tabMessageResponse: {
            ok: true,
            result: { message: "Search request initiated." }
        }
    });

    const response = await sendRuntimeMessage(messageListeners, {
        type: "EXECUTE_SEARCH",
        query: "python",
        expectedUrl: activeTab.url,
        ...targetIds
    });

    assert.equal(response.ok, true);
    assert.deepEqual(
        JSON.parse(JSON.stringify(calls.tabMessages[0].message)),
        {
            type: "EXECUTE_SEARCH",
            query: "python",
            expectedUrl: activeTab.url,
            ...targetIds
        }
    );
    assert.equal(calls.scriptInjection.length, 1);
});

test("toolbar click opens the side panel on the clicked tab and observation injects into that tab", async () => {
    const activeTab = { id: 41, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners, toolbarClickListeners } = loadBackground({ activeTab });

    toolbarClickListeners[0](activeTab);
    await Promise.resolve();

    assert.equal(calls.panelOpen.length, 1);
    assert.equal(calls.panelOpen[0].tabId, activeTab.id);

    const response = await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB"
    });

    assert.equal(response.ok, true);
    assert.equal(calls.scriptInjection.length, 1);
    assert.equal(calls.scriptInjection[0].target.tabId, activeTab.id);
    assert.equal(calls.tabMessages.length, 1);
    assert.equal(calls.tabMessages[0].tabId, activeTab.id);
    assert.equal(calls.tabMessages[0].message.type, "OBSERVE_PAGE");
});

test("toolbar click retains an activeTab fallback only for that tab until navigation", async () => {
    const activeTab = { id: 44, windowId: 7, url: "https://example.test/" };
    const {
        calls,
        messageListeners,
        tabUpdatedListeners,
        toolbarClickListeners
    } = loadBackground({ activeTab });

    toolbarClickListeners[0](activeTab);
    const access = await sendRuntimeMessage(messageListeners, {
        type: "GET_OBSERVATION_ACCESS",
        tabId: activeTab.id,
        origin: "https://example.test"
    });
    assert.equal(access.activeTabGrant, true);
    await Promise.resolve();
    assert.equal(
        calls.runtimeMessages[0].type,
        "TOOLBAR_ACTIVE_TAB_GRANT_AVAILABLE"
    );

    activeTab.url = "https://other.example/";
    tabUpdatedListeners[0](activeTab.id, { url: "https://other.example/" });
    await new Promise(resolve => setImmediate(resolve));
    const afterNavigation = await sendRuntimeMessage(messageListeners, {
        type: "GET_OBSERVATION_ACCESS",
        tabId: activeTab.id,
        origin: "https://other.example"
    });
    assert.equal(afterNavigation.activeTabGrant, false);
});

test("reload refreshes observation only for a watched active page with existing permission", async () => {
    const activeTab = { id: 61, windowId: 7, url: "https://example.test/" };
    const {
        calls,
        messageListeners,
        tabActivatedListeners,
        tabUpdatedListeners
    } = loadBackground({ activeTab, hostPermissionGranted: true });

    const initial = await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB",
        tabId: activeTab.id,
        expectedOrigin: "https://example.test"
    });
    assert.equal(initial.ok, true);
    assert.equal(calls.scriptInjection.length, 1);

    tabUpdatedListeners[0](activeTab.id, { status: "loading" });
    tabUpdatedListeners[0](activeTab.id, { status: "complete" });
    tabUpdatedListeners[0](activeTab.id, { status: "complete" });
    tabActivatedListeners[0]({ tabId: activeTab.id });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(calls.scriptInjection.length, 2);
    assert.equal(
        calls.runtimeMessages.some(message => message.type === "PAGE_OBSERVATION_UPDATED"),
        true
    );
    assert.equal(
        calls.tabMessages.some(({ message }) => message.type === "EXECUTE_SEARCH"),
        false
    );
});

test("valid page content change refreshes a watched active tab and notifies the Side Panel", async () => {
    const activeTab = { id: 65, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners, flushTimers } = loadBackground({
        activeTab,
        hostPermissionGranted: true,
        tabMessageResponse: {
            observation: {
                title: "Updated page",
                url: activeTab.url,
                visibleText: "New content"
            }
        }
    });
    await observeWatchedTab(messageListeners, activeTab);

    const responsePromise = sendContentMessage(
        messageListeners,
        pageContentChangedMessage(activeTab),
        contentChangeSender(activeTab)
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.pendingTimers.size, 1);
    assert.equal(
        calls.runtimeMessages.some(message => message.type === "PAGE_OBSERVATION_INVALIDATED"),
        true
    );

    await flushTimers();
    assert.equal((await responsePromise).ok, true);
    assert.equal(
        calls.runtimeMessages.some(message =>
            message.type === "PAGE_OBSERVATION_UPDATED" &&
            message.observation.visibleText === "New content"
        ),
        true
    );
    assert.equal(
        calls.tabMessages.filter(({ message }) => message.type === "OBSERVE_PAGE").length,
        2
    );
});

test("page content changes from an unwatched tab are rejected", async () => {
    const activeTab = { id: 66, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners } = loadBackground({
        activeTab,
        hostPermissionGranted: true
    });

    const response = await sendContentMessage(
        messageListeners,
        pageContentChangedMessage(activeTab),
        contentChangeSender(activeTab)
    );

    assert.equal(response.ok, false);
    assert.equal(calls.pendingTimers.size, 0);
    assert.equal(calls.scriptInjection.length, 0);
});

test("page content changes require a top-frame message from this extension", async () => {
    const activeTab = { id: 71, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners } = loadBackground({
        activeTab,
        hostPermissionGranted: true
    });
    await observeWatchedTab(messageListeners, activeTab);

    const invalidSender = contentChangeSender(activeTab);
    invalidSender.id = "different-extension";
    const response = await sendContentMessage(
        messageListeners,
        pageContentChangedMessage(activeTab),
        invalidSender
    );

    assert.equal(response.ok, false);
    assert.equal(calls.pendingTimers.size, 0);
});

test("page content changes from an inactive watched tab are rejected", async () => {
    const activeTab = { id: 67, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners } = loadBackground({
        activeTab,
        hostPermissionGranted: true
    });
    await observeWatchedTab(messageListeners, activeTab);
    activeTab.active = false;

    const response = await sendContentMessage(
        messageListeners,
        pageContentChangedMessage(activeTab),
        contentChangeSender(activeTab)
    );

    assert.equal(response.ok, false);
    assert.equal(calls.pendingTimers.size, 0);
    assert.equal(
        calls.runtimeMessages.some(message => message.type === "PAGE_OBSERVATION_INVALIDATED"),
        false
    );
});

test("page content change rejects URL and authorized-origin mismatches", async () => {
    const activeTab = { id: 68, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners } = loadBackground({
        activeTab,
        hostPermissionGranted: true
    });
    await observeWatchedTab(messageListeners, activeTab);

    const mismatchedReport = await sendContentMessage(
        messageListeners,
        { type: "PAGE_CONTENT_CHANGED", url: "https://example.test/other" },
        contentChangeSender(activeTab)
    );
    assert.equal(mismatchedReport.ok, false);

    activeTab.url = "https://other.example/";
    const mismatchedOrigin = await sendContentMessage(
        messageListeners,
        pageContentChangedMessage(activeTab),
        contentChangeSender(activeTab)
    );
    assert.equal(mismatchedOrigin.ok, false);
    assert.equal(calls.pendingTimers.size, 0);
});

test("repeated page content notifications are debounced and coalesced", async () => {
    const activeTab = { id: 69, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners, flushTimers } = loadBackground({
        activeTab,
        hostPermissionGranted: true
    });
    await observeWatchedTab(messageListeners, activeTab);

    const responses = [
        sendContentMessage(messageListeners, pageContentChangedMessage(activeTab), contentChangeSender(activeTab)),
        sendContentMessage(messageListeners, pageContentChangedMessage(activeTab), contentChangeSender(activeTab)),
        sendContentMessage(messageListeners, pageContentChangedMessage(activeTab), contentChangeSender(activeTab))
    ];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.pendingTimers.size, 1);
    assert.equal(
        calls.runtimeMessages.filter(message => message.type === "PAGE_OBSERVATION_INVALIDATED").length,
        1
    );

    await flushTimers();
    assert.deepEqual(
        (await Promise.all(responses)).map(response => response.ok),
        [true, true, true]
    );
    assert.equal(
        calls.tabMessages.filter(({ message }) => message.type === "OBSERVE_PAGE").length,
        2
    );
});

test("overlapping refreshes are prevented and changes during refresh cause one final refresh", async () => {
    const activeTab = { id: 70, windowId: 7, url: "https://example.test/" };
    let releaseSlowRefresh;
    const slowRefresh = new Promise(resolve => {
        releaseSlowRefresh = resolve;
    });
    let observationCalls = 0;
    let activeRefreshes = 0;
    let maximumConcurrentRefreshes = 0;
    const { calls, messageListeners, runNextTimer } = loadBackground({
        activeTab,
        hostPermissionGranted: true,
        tabMessageHandler(tabId, message) {
            if (message.type !== "OBSERVE_PAGE") {
                return { ok: true };
            }
            observationCalls += 1;
            activeRefreshes += 1;
            maximumConcurrentRefreshes = Math.max(
                maximumConcurrentRefreshes,
                activeRefreshes
            );
            const response = observationCalls === 2
                ? slowRefresh
                : Promise.resolve({
                    observation: {
                        title: "Updated page",
                        url: activeTab.url
                    }
                });
            return response.finally(() => {
                activeRefreshes -= 1;
            });
        }
    });
    await observeWatchedTab(messageListeners, activeTab);

    const firstNotification = sendContentMessage(
        messageListeners,
        pageContentChangedMessage(activeTab),
        contentChangeSender(activeTab)
    );
    await new Promise(resolve => setImmediate(resolve));
    runNextTimer();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(observationCalls, 2);

    const duringRefresh = [
        sendContentMessage(messageListeners, pageContentChangedMessage(activeTab), contentChangeSender(activeTab)),
        sendContentMessage(messageListeners, pageContentChangedMessage(activeTab), contentChangeSender(activeTab))
    ];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.pendingTimers.size, 0);

    releaseSlowRefresh({
        observation: {
            title: "First refresh",
            url: activeTab.url
        }
    });
    for (let turn = 0; turn < 8; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(observationCalls, 3);
    assert.equal(maximumConcurrentRefreshes, 1);
    assert.deepEqual(
        (await Promise.all([firstNotification, ...duringRefresh])).map(response => response.ok),
        [true, true, true]
    );
});

test("navigation to another origin invalidates the watch and does not auto-inject", async () => {
    const activeTab = { id: 62, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners, tabUpdatedListeners } = loadBackground({
        activeTab,
        hostPermissionGranted: true
    });
    await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB",
        tabId: activeTab.id,
        expectedOrigin: "https://example.test"
    });

    activeTab.url = "https://other.example/";
    tabUpdatedListeners[0](activeTab.id, { url: activeTab.url });
    await new Promise(resolve => setImmediate(resolve));
    tabUpdatedListeners[0](activeTab.id, { status: "complete" });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(calls.scriptInjection.length, 1);
    assert.equal(
        calls.runtimeMessages.some(message =>
            message.type === "PAGE_OBSERVATION_FAILED" &&
            /website changed/i.test(message.error)
        ),
        true
    );
});

test("automatic reconnect reports content-script injection failures", async () => {
    const activeTab = { id: 63, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners, tabUpdatedListeners } = loadBackground({
        activeTab,
        hostPermissionGranted: true,
        scriptInjectionErrorAfter: "Content script reconnect failed."
    });
    await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB",
        tabId: activeTab.id,
        expectedOrigin: "https://example.test"
    });

    tabUpdatedListeners[0](activeTab.id, { status: "complete" });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(calls.scriptInjection.length, 2);
    assert.equal(
        calls.runtimeMessages.some(message =>
            message.type === "PAGE_OBSERVATION_FAILED" &&
            /reconnect failed/i.test(message.error)
        ),
        true
    );
});

test("automatic refresh never requests origin permission", async () => {
    const activeTab = { id: 64, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners, tabUpdatedListeners } = loadBackground({
        activeTab,
        hostPermissionGranted: false
    });
    await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB",
        tabId: activeTab.id,
        expectedOrigin: "https://example.test"
    });

    tabUpdatedListeners[0](activeTab.id, { status: "complete" });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(calls.scriptInjection.length, 1);
    assert.equal(
        calls.runtimeMessages.some(message =>
            message.type === "PAGE_OBSERVATION_FAILED" &&
            /click observe active page/i.test(message.error)
        ),
        true
    );
});

test("observation rejects restricted pages without injecting a content script", async () => {
    const activeTab = { id: 42, windowId: 7, url: "chrome://settings/" };
    const { calls, messageListeners } = loadBackground({ activeTab });

    const response = await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB",
        tabId: activeTab.id
    });

    assert.equal(response.ok, false);
    assert.match(response.error, /cannot be observed/i);
    assert.equal(calls.scriptInjection.length, 0);
});

test("observation refuses a permission request for a different tab origin", async () => {
    const activeTab = { id: 45, windowId: 7, url: "https://wikipedia.org/" };
    const { calls, messageListeners } = loadBackground({ activeTab });

    const response = await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB",
        tabId: activeTab.id,
        expectedOrigin: "https://youtube.com"
    });

    assert.equal(response.ok, false);
    assert.match(response.error, /different website/i);
    assert.equal(calls.scriptInjection.length, 0);
});

test("observation stops if its cached tab is no longer active", async () => {
    const activeTab = {
        id: 46,
        windowId: 7,
        url: "https://example.test/",
        active: false
    };
    const { calls, messageListeners } = loadBackground({ activeTab });

    const response = await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB",
        tabId: activeTab.id,
        expectedOrigin: "https://example.test"
    });

    assert.equal(response.ok, false);
    assert.match(response.error, /active tab changed/i);
    assert.equal(calls.scriptInjection.length, 0);
});

test("observation reports when the Side Panel must request host permission", async () => {
    const activeTab = { id: 43, windowId: 7, url: "https://example.test/" };
    const { calls, messageListeners } = loadBackground({
        activeTab,
        scriptInjectionError:
            "Cannot access contents of the page. Extension manifest must request permission to access the respective host."
    });

    const response = await sendRuntimeMessage(messageListeners, {
        type: "OBSERVE_ACTIVE_TAB",
        tabId: activeTab.id
    });

    assert.equal(response.ok, false);
    assert.equal(response.requiresHostPermission, true);
    assert.equal(calls.scriptInjection.length, 1);
});

test("website navigation updates only the currently active tab", async () => {
    const activeTab = { id: 58, windowId: 9 };
    const { calls, messageListeners } = loadBackground({ activeTab });

    const response = await sendRuntimeMessage(messageListeners, {
        type: "NAVIGATE_ACTIVE_TAB",
        url: "https://www.youtube.com/results?search_query=music"
    });

    assert.equal(response.ok, true);
    assert.equal(response.tabId, activeTab.id);
    assert.equal(calls.tabUpdates.length, 1);
    assert.equal(calls.tabUpdates[0].tabId, activeTab.id);
    assert.equal(
        calls.tabUpdates[0].properties.url,
        "https://www.youtube.com/results?search_query=music"
    );
});

for (const url of [
    "",
    "not a url",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "https://user:password@example.test/"
]) {
    test(`website navigation rejects unsafe URL: ${url || "(empty)"}`, async () => {
        const activeTab = { id: 59, windowId: 9 };
        const { calls, messageListeners } = loadBackground({ activeTab });

        const response = await sendRuntimeMessage(messageListeners, {
            type: "NAVIGATE_ACTIVE_TAB",
            url
        });

        assert.equal(response.ok, false);
        assert.match(response.error, /URL|HTTP|HTTPS/i);
        assert.equal(calls.tabUpdates.length, 0);
    });
}

test("manifest keeps observation permissions narrow", () => {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(extensionPath, "manifest.json"), "utf8")
    );

    assert.ok(manifest.permissions.includes("activeTab"));
    assert.ok(manifest.permissions.includes("scripting"));
    assert.ok(manifest.permissions.includes("tabs"));
    assert.ok(manifest.permissions.includes("storage"));
    assert.ok(!manifest.host_permissions.includes("<all_urls>"));
    assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
    assert.ok(manifest.optional_host_permissions.includes("http://*/*"));
    assert.ok(!manifest.optional_host_permissions.includes("<all_urls>"));
});
