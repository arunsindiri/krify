const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionPath = path.resolve(__dirname, "..");
const targetId = "target-00000000-0000-4000-8000-000000000001";

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

function createObservation(url = "https://example.test/account") {
    return {
        title: "Account settings",
        url,
        visibleText: "Account settings",
        interactiveElements: [
            {
                index: 0,
                target_id: targetId,
                type: "button",
                label: "Open preferences",
                visible: true,
                disabled: false,
                submit_button: false
            }
        ]
    };
}

function validPlan(overrides = {}) {
    return {
        valid: true,
        target_id: targetId,
        element_type: "button",
        element_text: "Open preferences",
        action_description: "Open the preferences section.",
        expected_outcome: "The preference options become visible.",
        rejection_reason: null,
        ...overrides
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

function loadClickPanel({
    plan = validPlan(),
    planPromise = null,
    clickResponse = {
        ok: true,
        result: {
            status: "dispatched",
            message: "Click event dispatched. The page outcome was not verified."
        }
    },
    clickPromise = null
} = {}) {
    const elements = new Map();
    const activeTab = { id: 55, url: "https://example.test/account" };
    const observation = createObservation(activeTab.url);
    const calls = {
        fetches: [],
        requests: [],
        messages: [],
        tabQueries: 0,
        approvalAtExecution: undefined
    };
    const activatedListeners = [];
    const updatedListeners = [];
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
                calls.tabQueries += 1;
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
                if (message.type === "EXECUTE_APPROVED_CLICK") {
                    calls.approvalAtExecution = vm.runInContext(
                        "approvedClickApproval",
                        context
                    );
                    return clickPromise || clickResponse;
                }
                throw new Error(`Unexpected runtime message ${message.type}`);
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
    const fetch = async (url, options) => {
        calls.fetches.push(url);
        calls.requests.push({ url, options });
        if (url.endsWith("/click-plan")) {
            return planPromise || response(plan);
        }
        throw new Error(`Unexpected request ${url}`);
    };
    const context = {
        chrome,
        document,
        URL,
        fetch,
        console
    };
    const source = fs.readFileSync(path.join(extensionPath, "sidepanel.js"), "utf8");
    vm.runInNewContext(source, context);

    return {
        activeTab,
        calls,
        context,
        elements,
        observation,
        ready: vm.runInContext("refreshActiveTabContext()", context),
        async plan(instruction = "Open preferences") {
            elements.get("clickInstruction").value = instruction;
            return elements.get("planClick").listeners.click();
        },
        confirm() {
            return elements.get("confirmClick").listeners.click();
        },
        cancel() {
            return elements.get("cancelClick").listeners.click();
        },
        replaceObservation(nextObservation) {
            context.displayObservation(nextObservation);
        },
        tabEvents: { activatedListeners, updatedListeners }
    };
}

async function preparePlan(panel) {
    await panel.ready;
    panel.replaceObservation(panel.observation);
    await panel.plan();
}

async function approvePlan(panel) {
    await preparePlan(panel);
    await panel.confirm();
}

test("valid click plan displays all confirmation details and posts the current observation", async () => {
    const panel = loadClickPanel();
    await preparePlan(panel);

    assert.equal(panel.calls.requests.length, 1);
    assert.equal(panel.calls.requests[0].url, "http://127.0.0.1:8000/click-plan");
    const requestBody = JSON.parse(panel.calls.requests[0].options.body);
    assert.equal(requestBody.instruction, "Open preferences");
    assert.equal(requestBody.page.interactive_elements[0].target_id, targetId);
    assert.equal(panel.elements.get("clickConfirmation").hidden, false);
    assert.equal(panel.elements.get("clickConfirmationWebsite").textContent, "example.test");
    assert.equal(
        panel.elements.get("clickConfirmationAction").textContent,
        "Open the preferences section."
    );
    assert.equal(panel.elements.get("clickConfirmationTarget").textContent, "Open preferences");
    assert.equal(panel.elements.get("clickConfirmationType").textContent, "button");
    assert.equal(
        panel.elements.get("clickConfirmationOutcome").textContent,
        "The preference options become visible."
    );
});

test("invalid plans and target IDs not present in the observation are rejected", async () => {
    const rejectedPlan = loadClickPanel({
        plan: validPlan({ valid: false, target_id: null, rejection_reason: "Target is ambiguous." })
    });
    await preparePlan(rejectedPlan);
    assert.equal(rejectedPlan.elements.get("clickConfirmation").hidden, true);
    assert.match(rejectedPlan.elements.get("clickResult").textContent, /ambiguous/i);

    const unknownTarget = loadClickPanel({ plan: validPlan({
        target_id: "target-00000000-0000-4000-8000-000000000099"
    }) });
    await preparePlan(unknownTarget);
    assert.equal(unknownTarget.elements.get("clickConfirmation").hidden, true);
    assert.match(unknownTarget.elements.get("clickResult").textContent, /not in the current page observation/i);
});

test("cancel dismisses the click confirmation without creating approval", async () => {
    const panel = loadClickPanel();
    await preparePlan(panel);
    panel.cancel();

    assert.equal(panel.elements.get("clickConfirmation").hidden, true);
    assert.equal(panel.elements.get("clickResult").textContent, "Click plan cancelled.");
    assert.equal(vm.runInContext("approvedClickApproval", panel.context), null);
});

test("confirm consumes approval before sending one approved target request", async () => {
    const panel = loadClickPanel();
    await approvePlan(panel);

    const approvalRequests = panel.calls.messages.filter(
        message => message.type === "EXECUTE_APPROVED_CLICK"
    );
    assert.equal(approvalRequests.length, 1);
    assert.equal(panel.calls.approvalAtExecution, null);
    assert.equal(approvalRequests[0].targetId, targetId);
    assert.equal(approvalRequests[0].expectedElementType, "button");
    assert.equal(approvalRequests[0].expectedElementText, "Open preferences");
    assert.equal(approvalRequests[0].expectedHref, null);
    assert.equal(vm.runInContext("approvedClickApproval", panel.context), null);
    assert.equal(panel.elements.get("clickConfirmation").hidden, true);
    assert.match(panel.elements.get("clickResult").textContent, /^Click dispatched:/);
    assert.equal(panel.calls.messages.some(message => message.type === "EXECUTE_CLICK"), false);
    assert.equal(panel.calls.messages.some(message => message.type === "EXECUTE_SEARCH"), false);
    assert.equal(panel.context.consumeClickApproval(), null);
});

test("duplicate confirmation clicks create only one approval", async () => {
    const panel = loadClickPanel();
    await preparePlan(panel);
    const queriesBeforeConfirmation = panel.calls.tabQueries;

    const firstConfirm = panel.confirm();
    const duplicateConfirm = panel.confirm();
    await Promise.all([firstConfirm, duplicateConfirm]);

    assert.equal(vm.runInContext("approvedClickApproval", panel.context), null);
    assert.equal(panel.calls.messages.filter(message => message.type === "EXECUTE_CLICK").length, 0);
    assert.equal(panel.calls.messages.filter(message => message.type === "EXECUTE_APPROVED_CLICK").length, 1);
    assert.equal(panel.calls.tabQueries - queriesBeforeConfirmation, 1);
});

test("rejected execution is shown as rejected and is not retried", async () => {
    const panel = loadClickPanel({
        clickResponse: {
            ok: false,
            status: "rejected",
            error: "The approved target is no longer visible."
        }
    });
    await approvePlan(panel);

    assert.match(panel.elements.get("clickResult").textContent, /^Click rejected:/);
    assert.equal(panel.calls.messages.filter(message => message.type === "EXECUTE_APPROVED_CLICK").length, 1);
});

test("lost execution response is displayed as uncertain dispatch, not failure", async () => {
    const panel = loadClickPanel({
        clickResponse: {
            ok: true,
            result: {
                status: "dispatched",
                uncertain: true,
                message: "The page navigated before responding; the click may have been dispatched."
            }
        }
    });
    await approvePlan(panel);

    assert.match(panel.elements.get("clickResult").textContent, /^Click dispatched:/);
    assert.match(panel.elements.get("clickResult").textContent, /may have been dispatched/i);
    assert.doesNotMatch(panel.elements.get("clickResult").textContent, /failed/i);
    assert.equal(panel.calls.messages.filter(message => message.type === "EXECUTE_APPROVED_CLICK").length, 1);
});

test("runtime execution errors are shown as failed and are not retried", async () => {
    const panel = loadClickPanel({
        clickPromise: Promise.reject(new Error("Background service worker stopped."))
    });
    await approvePlan(panel);

    assert.match(panel.elements.get("clickResult").textContent, /^Click failed:/);
    assert.equal(panel.calls.messages.filter(message => message.type === "EXECUTE_APPROVED_CLICK").length, 1);
});

test("active tab change invalidates the plan before confirmation", async () => {
    const panel = loadClickPanel();
    await preparePlan(panel);
    panel.tabEvents.activatedListeners[0]({ tabId: 56 });
    await panel.confirm();

    assert.equal(vm.runInContext("approvedClickApproval", panel.context), null);
    assert.equal(panel.calls.messages.filter(message => message.type === "EXECUTE_APPROVED_CLICK").length, 0);
    assert.match(panel.elements.get("clickResult").textContent, /active tab changed/i);
});

test("a replacement observation invalidates the plan before confirmation", async () => {
    const panel = loadClickPanel();
    await preparePlan(panel);
    panel.replaceObservation({
        ...panel.observation,
        interactiveElements: []
    });
    await panel.confirm();

    assert.equal(vm.runInContext("approvedClickApproval", panel.context), null);
    assert.equal(panel.calls.messages.filter(message => message.type === "EXECUTE_APPROVED_CLICK").length, 0);
    assert.match(panel.elements.get("clickResult").textContent, /new page observation/i);
});

test("navigation invalidates the plan before confirmation", async () => {
    const panel = loadClickPanel();
    await preparePlan(panel);
    panel.activeTab.url = "https://example.test/other";
    panel.tabEvents.updatedListeners[0](panel.activeTab.id, {
        url: panel.activeTab.url
    });
    await panel.confirm();

    assert.equal(vm.runInContext("approvedClickApproval", panel.context), null);
    assert.equal(panel.calls.messages.filter(message => message.type === "EXECUTE_APPROVED_CLICK").length, 0);
    assert.match(panel.elements.get("clickResult").textContent, /webpage changed/i);
});

test("same-URL reload blocks planning until a fresh observation arrives", async () => {
    const panel = loadClickPanel();
    await preparePlan(panel);
    panel.tabEvents.updatedListeners[0](panel.activeTab.id, { status: "loading" });
    await panel.plan();

    assert.equal(panel.elements.get("clickConfirmation").hidden, true);
    assert.equal(panel.calls.requests.length, 1);
    assert.match(panel.elements.get("clickResult").textContent, /observe it again/i);

    panel.replaceObservation(createObservation(panel.activeTab.url));
    await panel.plan();
    assert.equal(panel.calls.requests.length, 2);
});

test("an expired observation cannot produce an approval", async () => {
    const panel = loadClickPanel();
    await panel.ready;
    panel.replaceObservation(panel.observation);
    vm.runInContext("currentObservationAt = Date.now() - 300000", panel.context);
    await panel.plan();
    await panel.confirm();

    assert.equal(panel.elements.get("clickConfirmation").hidden, true);
    assert.equal(vm.runInContext("approvedClickApproval", panel.context), null);
    assert.match(panel.elements.get("clickResult").textContent, /observation has expired/i);
});

test("an expired displayed plan cannot be approved", async () => {
    const panel = loadClickPanel();
    await preparePlan(panel);
    vm.runInContext("pendingClickConfirmation.expiresAt = Date.now() - 1", panel.context);
    await panel.confirm();

    assert.equal(panel.elements.get("clickConfirmation").hidden, true);
    assert.equal(vm.runInContext("approvedClickApproval", panel.context), null);
    assert.match(panel.elements.get("clickResult").textContent, /click plan has expired/i);
});