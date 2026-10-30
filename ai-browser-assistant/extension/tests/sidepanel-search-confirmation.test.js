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
        value: "",
        listeners: {},
        addEventListener(type, listener) {
            this.listeners[type] = listener;
        },
        append() {},
        replaceChildren() {}
    };
}

function createObservation(url = "https://www.udemy.com/courses/search/") {
    return {
        title: "Udemy search",
        url,
        visibleText: "Search courses",
        interactiveElements: [
            {
                index: 0,
                target_id: "target-00000000-0000-4000-8000-000000000001",
                type: "input (text)",
                label: "",
                placeholder: "Search for anything",
                name: "q",
                searchable: true,
                search_candidate: true,
                form_index: 0,
                submit_button: false
            },
            {
                index: 1,
                target_id: "target-00000000-0000-4000-8000-000000000002",
                type: "button",
                label: "Submit search",
                searchable: false,
                form_index: 0,
                submit_button: true
            }
        ],
        searchResultContainerCount: 1,
        searchResultLinks: []
    };
}

function response(data, ok = true) {
    return {
        ok,
        async json() {
            return data;
        }
    };
}

function loadSearchPanel({
    executionResponse = {
        ok: true,
        result: { message: 'Search request initiated for "python".' }
    },
    executionPromise = null
} = {}) {
    const elements = new Map();
    const calls = { fetches: [], messages: [] };
    const activeTab = { id: 8, url: "https://www.udemy.com/courses/search/" };
    const observation = createObservation();
    const plan = {
        action: "search",
        query: "python",
        input_target_id: "target-00000000-0000-4000-8000-000000000001",
        submit_target_id: "target-00000000-0000-4000-8000-000000000002",
        message: ""
    };
    const afterObservation = createObservation(
        "https://www.udemy.com/courses/search/?q=python"
    );
    const chrome = {
        tabs: {
            onActivated: { addListener() {} },
            onUpdated: { addListener() {} },
            async query() {
                return [activeTab];
            }
        },
        permissions: {
            async contains() {
                return false;
            },
            onAdded: { addListener() {} },
            onRemoved: { addListener() {} }
        },
        runtime: {
            onMessage: { addListener() {} },
            async sendMessage(message) {
                calls.messages.push(message);
                if (message.type === "GET_OBSERVATION_ACCESS") {
                    return { activeTabGrant: false };
                }
                if (message.type === "OBSERVE_ACTIVE_TAB") {
                    return { ok: true, observation: afterObservation };
                }
                if (message.type === "EXECUTE_SEARCH") {
                    return executionPromise || executionResponse;
                }
                throw new Error(`Unexpected message ${message.type}`);
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
    const fetch = async (url) => {
        calls.fetches.push(url);
        if (url.endsWith("/search-plan")) {
            return response(plan);
        }
        if (url.endsWith("/verify-search")) {
            return response({
                status: "results_found",
                message: "Matching results are visible."
            });
        }
        throw new Error(`Unexpected request ${url}`);
    };
    const source = fs.readFileSync(path.join(extensionPath, "sidepanel.js"), "utf8");
    const context = {
        chrome,
        document,
        URL,
        fetch,
        console,
        setTimeout(callback) {
            callback();
            return 0;
        }
    };
    vm.runInNewContext(source, context);

    return {
        calls,
        elements,
        observation,
        ready: vm.runInContext("refreshActiveTabContext()", context),
        showObservation() {
            context.displayObservation(observation);
        },
        replaceObservation(nextObservation) {
            context.displayObservation(nextObservation);
        },
        search() {
            elements.get("searchQuery").value = "python";
            return elements.get("searchPage").listeners.click();
        },
        confirm() {
            return elements.get("confirmSearch").listeners.click();
        },
        cancel() {
            return elements.get("cancelSearch").listeners.click();
        }
    };
}

test("shows the selected search and executes it after confirmation", async () => {
    const panel = loadSearchPanel();
    await panel.ready;
    panel.showObservation();

    await panel.search();

    assert.equal(panel.elements.get("searchConfirmation").hidden, false);
    assert.equal(panel.elements.get("searchConfirmationWebsite").textContent, "www.udemy.com");
    assert.equal(panel.elements.get("searchConfirmationQuery").textContent, "python");
    assert.equal(
        panel.elements.get("searchConfirmationInput").textContent,
        "Search for anything"
    );
    assert.equal(
        panel.elements.get("searchConfirmationSubmit").textContent,
        'the "Submit search" button'
    );
    assert.equal(panel.elements.get("searchPage").disabled, true);

    await panel.confirm();

    const executions = panel.calls.messages.filter(message => message.type === "EXECUTE_SEARCH");
    assert.equal(executions.length, 1);
    assert.equal(executions[0].query, "python");
    assert.equal(executions[0].inputTargetId, "target-00000000-0000-4000-8000-000000000001");
    assert.equal(executions[0].submitTargetId, "target-00000000-0000-4000-8000-000000000002");
    assert.equal(panel.elements.get("searchConfirmation").hidden, true);
    assert.match(panel.elements.get("searchResult").textContent, /Results found/);
    assert.equal(panel.elements.get("searchPage").disabled, false);
});

test("cancel discards the pending plan without executing it", async () => {
    const panel = loadSearchPanel();
    await panel.ready;
    panel.showObservation();
    await panel.search();

    panel.cancel();
    panel.cancel();

    assert.equal(
        panel.calls.messages.filter(message => message.type === "EXECUTE_SEARCH").length,
        0
    );
    assert.equal(panel.elements.get("searchConfirmation").hidden, true);
    assert.equal(panel.elements.get("searchResult").textContent, "Search cancelled.");
    assert.equal(panel.elements.get("searchPage").disabled, false);
});

test("repeated confirmation clicks submit the plan only once", async () => {
    let resolveExecution;
    const executionPromise = new Promise(resolve => {
        resolveExecution = resolve;
    });
    const panel = loadSearchPanel({ executionPromise });
    await panel.ready;
    panel.showObservation();
    await panel.search();

    const firstConfirm = panel.confirm();
    const repeatedConfirm = panel.confirm();
    assert.equal(
        panel.calls.messages.filter(message => message.type === "EXECUTE_SEARCH").length,
        1
    );
    resolveExecution({
        ok: true,
        result: { message: 'Search request initiated for "python".' }
    });
    await Promise.all([firstConfirm, repeatedConfirm]);

    assert.equal(
        panel.calls.messages.filter(message => message.type === "EXECUTE_SEARCH").length,
        1
    );
});

test("a replacement observation invalidates the pending target", async () => {
    const panel = loadSearchPanel();
    await panel.ready;
    panel.showObservation();
    await panel.search();

    panel.replaceObservation(createObservation("https://www.udemy.com/another-page"));
    await panel.confirm();

    assert.equal(
        panel.calls.messages.filter(message => message.type === "EXECUTE_SEARCH").length,
        0
    );
    assert.equal(panel.elements.get("searchConfirmation").hidden, true);
    assert.match(panel.elements.get("searchResult").textContent, /confirmation discarded/i);
});

test("a content-script rejection for a stale target is surfaced without verification", async () => {
    const panel = loadSearchPanel({
        executionResponse: {
            ok: false,
            error: "The selected search field changed or is not safe to use."
        }
    });
    await panel.ready;
    panel.showObservation();
    await panel.search();

    await panel.confirm();

    assert.equal(panel.calls.fetches.filter(url => url.endsWith("/verify-search")).length, 0);
    assert.match(panel.elements.get("searchResult").textContent, /field changed or is not safe/i);
});
