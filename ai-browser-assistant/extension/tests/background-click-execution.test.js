const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionPath = path.resolve(__dirname, "..");
const sidePanelUrl = "chrome-extension://extension-id/sidepanel.html";
const targetId = "target-00000000-0000-4000-8000-000000000001";

function loadBackground({
    activeTab = { id: 45, url: "https://example.test/account", active: true },
    hasOriginPermission = true,
    storedGrant = null,
    readinessResponse = { ok: true },
    clickResponse = {
        ok: true,
        result: {
            status: "dispatched",
            message: "Click event dispatched. The page outcome was not verified."
        }
    },
    readinessError = null,
    clickError = null,
    mutateTabAfterClickError = false
} = {}) {
    const messageListeners = [];
    const calls = {
        messages: [],
        queries: 0,
        permissionChecks: [],
        storage: {},
        tabGets: 0
    };
    if (storedGrant) {
        calls.storage.toolbarActiveTabGrant = storedGrant;
    }

    const chrome = {
        runtime: {
            id: "extension-id",
            getURL(pathname) {
                return `chrome-extension://extension-id/${pathname}`;
            },
            onMessage: {
                addListener(listener) {
                    messageListeners.push(listener);
                }
            },
            sendMessage() {
                return Promise.resolve();
            }
        },
        tabs: {
            onUpdated: { addListener() {} },
            onActivated: { addListener() {} },
            onRemoved: { addListener() {} },
            async query() {
                calls.queries += 1;
                return activeTab ? [activeTab] : [];
            },
            async get(tabId) {
                calls.tabGets += 1;
                assert.equal(tabId, activeTab?.id);
                return activeTab;
            },
            async sendMessage(tabId, message) {
                calls.messages.push({ tabId, message });
                if (message.type === "PING_CLICK_EXECUTOR") {
                    if (readinessError) {
                        throw new Error(readinessError);
                    }
                    return readinessResponse;
                }
                if (message.type === "EXECUTE_APPROVED_CLICK") {
                    if (clickError) {
                        if (mutateTabAfterClickError && activeTab) {
                            activeTab.url = "https://example.test/next";
                        }
                        throw new Error(clickError);
                    }
                    return clickResponse;
                }
                return { ok: true };
            }
        },
        storage: {
            session: {
                async get(key) {
                    if (Array.isArray(key)) {
                        return Object.fromEntries(key.map(item => [item, calls.storage[item]]));
                    }
                    return { [key]: calls.storage[key] };
                },
                async set(values) {
                    Object.assign(calls.storage, values);
                },
                async remove(key) {
                    delete calls.storage[key];
                }
            }
        },
        permissions: {
            async contains(options) {
                calls.permissionChecks.push(options);
                return hasOriginPermission;
            }
        },
        scripting: {
            async executeScript() {}
        },
        action: { onClicked: { addListener() {} } },
        sidePanel: { open: async () => {} }
    };

    const source = fs.readFileSync(path.join(extensionPath, "background.js"), "utf8");
    vm.runInNewContext(source, { chrome, console, URL });

    return { calls, messageListeners, activeTab };
}

function clickMessage(overrides = {}) {
    return {
        type: "EXECUTE_APPROVED_CLICK",
        tabId: 45,
        expectedUrl: "https://example.test/account",
        targetId,
        expectedElementType: "a",
        expectedElementText: "Profile",
        expectedHref: "https://example.test/profile",
        approvalExpiresAt: Date.now() + 30_000,
        ...overrides
    };
}

function sendRuntimeMessage(messageListeners, message, sender = {
    id: "extension-id",
    url: sidePanelUrl
}) {
    return new Promise(resolve => {
        const keepChannelOpen = messageListeners[0](message, sender, resolve);
        if (!keepChannelOpen) {
            resolve(undefined);
        }
    });
}

test("approved click validates and relays only target metadata", async () => {
    const { calls, messageListeners } = loadBackground();
    const response = await sendRuntimeMessage(
        messageListeners,
        clickMessage({ selector: "a[href]", javascript: "alert(1)", arbitraryUrl: "https://evil.test" })
    );

    assert.equal(response.ok, true);
    assert.equal(response.result.status, "dispatched");
    assert.equal(calls.messages.length, 2);
    assert.equal(calls.messages[0].message.type, "PING_CLICK_EXECUTOR");
    assert.deepEqual(
        JSON.parse(JSON.stringify(calls.messages[1].message)),
        {
            type: "EXECUTE_APPROVED_CLICK",
            targetId,
            expectedUrl: "https://example.test/account",
            expectedElementType: "a",
            expectedElementText: "Profile",
            expectedHref: "https://example.test/profile",
            approvalExpiresAt: calls.messages[1].message.approvalExpiresAt
        }
    );
    assert.equal(calls.permissionChecks[0].origins[0], "https://example.test/*");
});

test("non-Side-Panel sender is rejected", async () => {
    const { calls, messageListeners } = loadBackground();
    const response = await sendRuntimeMessage(
        messageListeners,
        clickMessage(),
        { id: "extension-id", url: "chrome-extension://extension-id/content.js" }
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.match(response.error, /Side Panel/i);
    assert.equal(calls.messages.length, 0);
});

test("wrong active tab or URL is rejected before contacting the page", async () => {
    const wrongTab = loadBackground({
        activeTab: { id: 99, url: "https://example.test/account", active: true }
    });
    const tabResponse = await sendRuntimeMessage(wrongTab.messageListeners, clickMessage());
    assert.equal(tabResponse.status, "rejected");
    assert.equal(wrongTab.calls.messages.length, 0);

    const wrongUrl = loadBackground();
    const urlResponse = await sendRuntimeMessage(
        wrongUrl.messageListeners,
        clickMessage({ expectedUrl: "https://example.test/other" })
    );
    assert.equal(urlResponse.status, "rejected");
    assert.equal(wrongUrl.calls.messages.length, 0);
});

test("missing active tab is rejected without contacting content.js", async () => {
    const { calls, messageListeners } = loadBackground({ activeTab: null });
    const response = await sendRuntimeMessage(messageListeners, clickMessage());

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.match(response.error, /active page/i);
    assert.equal(calls.messages.length, 0);
});

test("unsafe destination metadata is rejected before relay", async () => {
    const { calls, messageListeners } = loadBackground();
    const response = await sendRuntimeMessage(
        messageListeners,
        clickMessage({ expectedHref: "javascript:alert(1)" })
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.match(response.error, /not safe HTTP or HTTPS/i);
    assert.equal(calls.messages.length, 0);
});

test("missing site access rejects the request without asking for permission", async () => {
    const { calls, messageListeners } = loadBackground({ hasOriginPermission: false });
    const response = await sendRuntimeMessage(messageListeners, clickMessage());

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.match(response.error, /no longer has access/i);
    assert.equal(calls.messages.length, 0);
});

test("toolbar activeTab grant is accepted for the same tab and origin", async () => {
    const { calls, messageListeners } = loadBackground({
        hasOriginPermission: false,
        storedGrant: { tabId: 45, origin: "https://example.test" }
    });
    const response = await sendRuntimeMessage(messageListeners, clickMessage());

    assert.equal(response.ok, true);
    assert.equal(calls.messages.length, 2);
});

test("missing content script fails before sending an execution request", async () => {
    const { calls, messageListeners } = loadBackground({
        readinessError: "Could not establish connection. Receiving end does not exist."
    });
    const response = await sendRuntimeMessage(messageListeners, clickMessage());

    assert.equal(response.ok, false);
    assert.equal(response.status, "failed");
    assert.match(response.error, /executor is unavailable/i);
    assert.deepEqual(calls.messages.map(item => item.message.type), ["PING_CLICK_EXECUTOR"]);
});

test("content rejection is returned without retry", async () => {
    const { calls, messageListeners } = loadBackground({
        clickResponse: { ok: false, error: "The target is no longer visible." }
    });
    const response = await sendRuntimeMessage(messageListeners, clickMessage());

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.match(response.error, /no longer visible/i);
    assert.equal(calls.messages.filter(item => item.message.type === "EXECUTE_APPROVED_CLICK").length, 1);
});

test("lost response after navigation is uncertain dispatch and is never retried", async () => {
    const { calls, messageListeners } = loadBackground({
        clickError: "The message port closed before a response was received.",
        mutateTabAfterClickError: true
    });
    const response = await sendRuntimeMessage(messageListeners, clickMessage());

    assert.equal(response.ok, true);
    assert.equal(response.result.status, "dispatched");
    assert.equal(response.result.uncertain, true);
    assert.match(response.result.message, /may have been dispatched/i);
    assert.equal(calls.messages.filter(item => item.message.type === "EXECUTE_APPROVED_CLICK").length, 1);
});