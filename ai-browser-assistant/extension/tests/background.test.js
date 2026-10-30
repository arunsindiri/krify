const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionPath = path.resolve(__dirname, "..");

function loadBackground({ activeTab }) {
    const toolbarClickListeners = [];
    const messageListeners = [];
    const calls = {
        panelOpen: [],
        scriptInjection: [],
        tabMessages: []
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
            }
        },
        sidePanel: {
            open(options) {
                calls.panelOpen.push(options);
                return Promise.resolve();
            }
        },
        tabs: {
            async query() {
                return [activeTab];
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
        scripting: {
            async executeScript(options) {
                calls.scriptInjection.push(options);
            }
        }
    };

    const source = fs.readFileSync(path.join(extensionPath, "background.js"), "utf8");
    vm.runInNewContext(source, {
        chrome,
        console
    });

    return { calls, messageListeners, toolbarClickListeners };
}

test("toolbar click opens the side panel on the clicked tab and observation injects into that tab", async () => {
    const activeTab = { id: 41, windowId: 7 };
    const { calls, messageListeners, toolbarClickListeners } = loadBackground({ activeTab });

    toolbarClickListeners[0](activeTab);
    await Promise.resolve();

    assert.equal(calls.panelOpen.length, 1);
    assert.equal(calls.panelOpen[0].tabId, activeTab.id);

    const response = await new Promise((resolve) => {
        const keepChannelOpen = messageListeners[0](
            { type: "OBSERVE_ACTIVE_TAB" },
            {},
            resolve
        );
        assert.equal(keepChannelOpen, true);
    });

    assert.equal(response.ok, true);
    assert.equal(calls.scriptInjection.length, 1);
    assert.equal(calls.scriptInjection[0].target.tabId, activeTab.id);
    assert.equal(calls.tabMessages.length, 1);
    assert.equal(calls.tabMessages[0].tabId, activeTab.id);
    assert.equal(calls.tabMessages[0].message.type, "OBSERVE_PAGE");
});

test("manifest keeps observation permissions narrow", () => {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(extensionPath, "manifest.json"), "utf8")
    );

    assert.ok(manifest.permissions.includes("activeTab"));
    assert.ok(manifest.permissions.includes("scripting"));
    assert.ok(!manifest.host_permissions.includes("<all_urls>"));
});
