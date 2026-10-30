const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionPath = path.resolve(__dirname, "..");

function createElement() {
    return {
        disabled: false,
        hidden: false,
        textContent: "",
        listeners: {},
        addEventListener(type, listener) {
            this.listeners[type] = listener;
        },
        append() {},
        replaceChildren() {}
    };
}

function loadSidePanel({
    activeTab,
    observeResponses,
    permissionGranted = true,
    permissionContainsAfterRequest = true,
    accessResponse = { activeTabGrant: false }
}) {
    const elements = new Map();
    const calls = {
        permissionRequests: [],
        messages: [],
        permissionChecks: []
    };
    let clickHandlerActive = false;
    const activatedListeners = [];
    const updatedListeners = [];
    const permissionAddedListeners = [];
    const permissionRemovedListeners = [];
    const runtimeMessageListeners = [];
    const chrome = {
        tabs: {
            onActivated: {
                addListener(listener) {
                    activatedListeners.push(listener);
                }
            },
            onUpdated: {
                addListener(listener) {
                    updatedListeners.push(listener);
                }
            },
            async query() {
                return [activeTab];
            }
        },
        permissions: {
            async request(options) {
                assert.equal(clickHandlerActive, true);
                calls.permissionRequests.push(options);
                return permissionGranted;
            },
            async contains(options) {
                calls.permissionChecks.push(options);
                return calls.permissionRequests.length > 0
                    ? permissionContainsAfterRequest
                    : false;
            },
            onAdded: {
                addListener(listener) {
                    permissionAddedListeners.push(listener);
                }
            },
            onRemoved: {
                addListener(listener) {
                    permissionRemovedListeners.push(listener);
                }
            }
        },
        runtime: {
            onMessage: {
                addListener(listener) {
                    runtimeMessageListeners.push(listener);
                }
            },
            async sendMessage(message) {
                calls.messages.push(message);
                if (message.type === "GET_OBSERVATION_ACCESS") {
                    return accessResponse;
                }
                return observeResponses.shift();
            }
        }
    };
    const document = {
        getElementById(id) {
            if (!elements.has(id)) {
                elements.set(id, createElement());
            }
            return elements.get(id);
        },
        createElement() {
            return createElement();
        }
    };

    const source = fs.readFileSync(path.join(extensionPath, "sidepanel.js"), "utf8");
    const vmContext = {
        chrome,
        document,
        URL
    };
    vm.runInNewContext(source, vmContext);

    return {
        calls,
        elements,
        observe: () => {
            clickHandlerActive = true;
            const result = elements.get("observePage").listeners.click();
            clickHandlerActive = false;
            return result;
        },
        ready: vm.runInContext("refreshActiveTabContext()", vmContext),
        displayObservation(nextObservation) {
            return vmContext.displayObservation(nextObservation);
        },
        handleLifecycleMessage(message) {
            return vm.runInContext(
                `handlePageObservationLifecycleMessage(${JSON.stringify(message)})`,
                vmContext
            );
        },
        tabEvents: { activatedListeners, updatedListeners },
        permissionEvents: { permissionAddedListeners, permissionRemovedListeners },
        runtimeMessageListeners
    };
}

const observation = {
    title: "Example",
    url: "https://example.test/",
    visibleText: "Page text",
    interactiveElements: []
};

test("requests only the active site's origin and resumes observation after grant", async () => {
    const { calls, elements, observe, ready } = loadSidePanel({
        activeTab: {
            id: 17,
            url: "https://example.test/path?query=value"
        },
        observeResponses: [{ ok: true, observation }]
    });

    await ready;
    const observationPromise = observe();
    await observationPromise;

    assert.equal(calls.permissionRequests.length, 1);
    assert.deepEqual(
        JSON.parse(JSON.stringify(calls.permissionRequests[0])),
        { origins: ["https://example.test/*"] }
    );
    const observationMessages = calls.messages.filter(
        message => message.type === "OBSERVE_ACTIVE_TAB"
    );
    assert.equal(calls.permissionChecks.some(
        permission => permission.origins?.[0] === "https://example.test/*"
    ), true);
    assert.equal(observationMessages.length, 1);
    assert.equal(observationMessages[0].tabId, 17);
    assert.equal(observationMessages[0].expectedOrigin, "https://example.test");
    assert.equal(elements.get("observationStatus").textContent, "Page observation complete.");
});

test("requests access for the active tab's new origin after navigation", async () => {
    const activeTab = {
        id: 21,
        url: "https://youtube.com/"
    };
    const { calls, observe, ready, tabEvents } = loadSidePanel({
        activeTab,
        observeResponses: [{ ok: true, observation }],
        permissionGranted: true
    });

    await ready;
    activeTab.url = "https://www.wikipedia.org/wiki/Main_Page";
    tabEvents.updatedListeners[0](activeTab.id, { url: activeTab.url });
    await new Promise(resolve => setImmediate(resolve));

    const observationPromise = observe();
    await observationPromise;

    assert.deepEqual(
        JSON.parse(JSON.stringify(calls.permissionRequests[0])),
        { origins: ["https://www.wikipedia.org/*"] }
    );
    const observationMessages = calls.messages.filter(
        message => message.type === "OBSERVE_ACTIVE_TAB"
    );
    assert.equal(observationMessages.length, 1);
    assert.equal(observationMessages[0].tabId, activeTab.id);
    assert.equal(observationMessages[0].expectedOrigin, "https://www.wikipedia.org");
});

test("uses existing activeTab access without requesting an optional host permission", async () => {
    const { calls, elements, observe, ready } = loadSidePanel({
        activeTab: {
            id: 20,
            url: "https://example.test/page"
        },
        observeResponses: [{ ok: true, observation }],
        accessResponse: { activeTabGrant: true }
    });

    await ready;
    await observe();

    assert.equal(calls.permissionRequests.length, 0);
    assert.equal(
        calls.messages.filter(message => message.type === "OBSERVE_ACTIVE_TAB").length,
        1
    );
    assert.equal(elements.get("observationStatus").textContent, "Page observation complete.");
});

test("refreshes toolbar activeTab fallback when the panel is already open", async () => {
    const accessResponse = { activeTabGrant: false };
    const { calls, observe, ready, runtimeMessageListeners } = loadSidePanel({
        activeTab: {
            id: 23,
            url: "https://example.test/"
        },
        observeResponses: [{ ok: true, observation }],
        accessResponse
    });

    await ready;
    accessResponse.activeTabGrant = true;
    runtimeMessageListeners[0]({
        type: "TOOLBAR_ACTIVE_TAB_GRANT_AVAILABLE",
        tabId: 23,
        origin: "https://example.test"
    });
    await new Promise(resolve => setImmediate(resolve));
    await observe();

    assert.equal(calls.permissionRequests.length, 0);
    assert.equal(
        calls.messages.filter(message => message.type === "OBSERVE_ACTIVE_TAB").length,
        1
    );
});

test("clears stale page state and displays the fresh observation after reload", async () => {
    const activeTab = {
        id: 25,
        url: observation.url
    };
    const { elements, ready, displayObservation, handleLifecycleMessage } = loadSidePanel({
        activeTab,
        observeResponses: []
    });
    await ready;
    displayObservation(observation);

    await handleLifecycleMessage({
        type: "PAGE_OBSERVATION_INVALIDATED",
        tabId: activeTab.id
    });
    assert.equal(elements.get("observation").hidden, true);
    assert.match(elements.get("observationStatus").textContent, /changed/i);

    const refreshedObservation = {
        ...observation,
        title: "Refreshed page",
        visibleText: "New document content"
    };
    await handleLifecycleMessage({
        type: "PAGE_OBSERVATION_UPDATED",
        tabId: activeTab.id,
        observation: refreshedObservation
    });

    assert.equal(elements.get("observation").hidden, false);
    assert.equal(elements.get("pageTitle").textContent, "Refreshed page");
    assert.equal(elements.get("pageText").textContent, "New document content");
    assert.match(elements.get("observationStatus").textContent, /refreshed after navigation/i);
});

test("reports restricted-page and reconnect failures without retaining stale observation", async () => {
    const activeTab = { id: 26, url: "chrome://settings/" };
    const { elements, ready, displayObservation, handleLifecycleMessage } = loadSidePanel({
        activeTab,
        observeResponses: []
    });
    await ready;
    displayObservation(observation);

    await handleLifecycleMessage({
        type: "PAGE_OBSERVATION_FAILED",
        tabId: activeTab.id,
        error: "This browser page cannot be observed."
    });

    assert.equal(elements.get("observation").hidden, true);
    assert.match(elements.get("observationStatus").textContent, /cannot be observed/i);
});

test("explains when the user denies permission for the active site", async () => {
    const { calls, elements, observe, ready } = loadSidePanel({
        activeTab: {
            id: 18,
            url: "https://private.example/account"
        },
        observeResponses: [],
        permissionGranted: false
    });

    await ready;
    await observe();

    assert.equal(calls.permissionRequests.length, 1);
    assert.match(elements.get("observationStatus").textContent, /access to private\.example was denied/i);
    assert.equal(
        calls.messages.filter(message => message.type === "OBSERVE_ACTIVE_TAB").length,
        0
    );
});

test("stops if Chrome reports grant but the requested origin is not present", async () => {
    const { calls, elements, observe, ready } = loadSidePanel({
        activeTab: {
            id: 22,
            url: "https://example.test/"
        },
        observeResponses: [],
        permissionGranted: true,
        permissionContainsAfterRequest: false
    });

    await ready;
    await observe();

    assert.equal(calls.permissionChecks.some(
        permission => permission.origins?.[0] === "https://example.test/*"
    ), true);
    assert.equal(
        calls.messages.filter(message => message.type === "OBSERVE_ACTIVE_TAB").length,
        0
    );
    assert.match(elements.get("observationStatus").textContent, /denied/i);
});

for (const url of [
    "chrome://settings/",
    "https://chromewebstore.google.com/detail/example",
    "https://chrome.google.com/webstore/detail/example"
]) {
    test(`does not request access for restricted page ${url}`, async () => {
        const { calls, elements, observe, ready } = loadSidePanel({
            activeTab: { id: 19, url },
            observeResponses: []
        });

        await ready;
        await observe();

        assert.equal(calls.permissionRequests.length, 0);
        assert.equal(
            calls.messages.filter(message => message.type === "OBSERVE_ACTIVE_TAB").length,
            0
        );
        assert.match(elements.get("observationStatus").textContent, /protected browser pages cannot be observed/i);
    });
}
