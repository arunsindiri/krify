const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionPath = path.resolve(__dirname, "..");

function loadBackground({ activeTab, scriptInjectionError }) {
    const toolbarClickListeners = [];
    const messageListeners = [];
    const tabUpdatedListeners = [];
    const tabRemovedListeners = [];
    const calls = {
        panelOpen: [],
        scriptInjection: [],
        tabMessages: [],
        tabUpdates: [],
        runtimeMessages: [],
        sessionStorage: {}
    };

    const chrome = {
        action: {
            onClicked: {
                addListener(listener) {
                    toolbarClickListeners.push(listener);
                }
            }
        },
        runtime: {
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
            onRemoved: {
                addListener(listener) {
                    tabRemovedListeners.push(listener);
                }
            },
            async query() {
                return [activeTab];
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
                return {
                    observation: {
                        title: "Test page",
                        url: "https://example.test/"
                    }
                };
            }
        },
        storage: {
            session: {
                async get(key) {
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
                if (scriptInjectionError) {
                    throw new Error(scriptInjectionError);
                }
            }
        }
    };

    chrome.permissions = {
        async contains() {
            return false;
        }
    };

    const source = fs.readFileSync(path.join(extensionPath, "background.js"), "utf8");
    vm.runInNewContext(source, {
        chrome,
        console,
        URL
    });

    return {
        calls,
        messageListeners,
        tabRemovedListeners,
        tabUpdatedListeners,
        toolbarClickListeners
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
    const afterNavigation = await sendRuntimeMessage(messageListeners, {
        type: "GET_OBSERVATION_ACCESS",
        tabId: activeTab.id,
        origin: "https://other.example"
    });
    assert.equal(afterNavigation.activeTabGrant, false);
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
