const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionPath = path.resolve(__dirname, "..");

class FakeForm {
    constructor(action = "/courses/search/") {
        this.attributes = new Map([["action", action]]);
        this.submitCalls = [];
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    requestSubmit(button) {
        this.submitCalls.push(button || null);
    }
}

class FakeElement {
    constructor(tagName, form, attributes = {}) {
        this.tagName = tagName.toUpperCase();
        this.form = form;
        this.attributes = new Map(Object.entries(attributes));
        this.disabled = false;
        this.readOnly = false;
        this.isConnected = true;
        this.visible = true;
        this.innerText = "";
        this.textContent = "";
        this.labels = [];
        this.events = [];
        this.clickCalls = 0;
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    getClientRects() {
        return this.visible ? [{ width: 10, height: 10 }] : [];
    }

    matches(selector) {
        return selector === ":disabled" && this.disabled;
    }

    dispatchEvent(event) {
        this.events.push(event.type);
        return true;
    }

    click() {
        this.clickCalls += 1;
    }
}

class FakeInput extends FakeElement {
    constructor(form) {
        super("input", form, {
            type: "text",
            name: "q",
            id: "search-field",
            placeholder: "Search for anything",
            role: "combobox",
            autocomplete: "off"
        });
        this._value = "python";
    }

    get type() {
        return this.getAttribute("type");
    }

    get name() {
        return this.getAttribute("name");
    }

    get value() {
        return this._value;
    }

    set value(value) {
        this._value = value;
    }
}

class FakeButton extends FakeElement {
    constructor(form) {
        super("button", form, { type: "submit" });
    }

    get type() {
        return this.getAttribute("type");
    }
}

function createHarness() {
    const form = new FakeForm();
    const input = new FakeInput(form);
    const button = new FakeButton(form);
    let candidates = [input, button];
    const listeners = [];
    const errors = [];
    const windowListeners = [];
    const document = {
        body: { innerText: "Search courses" },
        get forms() {
            return Array.from(new Set(candidates.map(element => element.form).filter(Boolean)));
        },
        documentElement: {
            contains(element) {
                return element.isConnected;
            }
        },
        querySelectorAll(selector) {
            if (selector.startsWith("button, a[href]")) {
                return candidates;
            }
            return [];
        }
    };
    const window = {
        location: {
            href: "https://www.udemy.com/courses/search/?q=python",
            protocol: "https:",
            origin: "https://www.udemy.com"
        },
        getComputedStyle(element) {
            return {
                visibility: element.visible ? "visible" : "hidden",
                display: element.visible ? "block" : "none",
                opacity: element.visible ? "1" : "0"
            };
        },
        addEventListener(type, listener, options) {
            windowListeners.push({ type, listener, options });
        }
    };
    const context = {
        chrome: {
            runtime: {
                onMessage: {
                    addListener(listener) {
                        listeners.push(listener);
                    }
                }
            }
        },
        document,
        window,
        crypto: crypto.webcrypto,
        URL,
        Event: class {
            constructor(type, options) {
                this.type = type;
                this.bubbles = options.bubbles;
            }
        },
        HTMLFormElement: FakeForm,
        setTimeout(callback) {
            callback();
            return 0;
        },
        console: {
            error(...args) {
                errors.push(args);
            }
        }
    };
    const source = fs.readFileSync(path.join(extensionPath, "content.js"), "utf8");
    vm.runInNewContext(source, context);

    function send(message) {
        let response;
        listeners[0](message, {}, value => {
            response = value;
        });
        return response;
    }

    const observationResponse = send({ type: "OBSERVE_PAGE" });
    const inputDescriptor = observationResponse.observation.interactiveElements.find(
        element => element.type === "input (text)"
    );
    const buttonDescriptor = observationResponse.observation.interactiveElements.find(
        element => element.submit_button
    );
    const executeMessage = {
        type: "EXECUTE_SEARCH",
        query: "c++",
        expectedUrl: window.location.href,
        inputTargetId: inputDescriptor.target_id,
        submitTargetId: buttonDescriptor.target_id
    };

    return {
        button,
        candidates,
        document,
        executeMessage,
        errors,
        form,
        input,
        observation: observationResponse.observation,
        window,
        runtimeListenerCount: () => listeners.length,
        installAgain() {
            vm.runInContext(source, context);
        },
        windowListeners,
        setCandidates(elements) {
            candidates = elements;
        },
        send,
        context
    };
}

test("observations issue opaque target IDs and tolerate reordered visible elements", () => {
    const harness = createHarness();
    const targetIds = harness.observation.interactiveElements.map(element => element.target_id);

    assert.match(targetIds[0], /^target-[0-9a-f-]{36}$/);
    assert.equal(new Set(targetIds).size, targetIds.length);

    const extraButton = new FakeButton(null);
    harness.setCandidates([extraButton, harness.button, harness.input]);
    const result = harness.send(harness.executeMessage);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(harness.input.value, "c++");
    assert.deepEqual(harness.form.submitCalls, [harness.button]);
});

test("observations report visibility and disabled state for buttons and links", () => {
    const harness = createHarness();
    const link = new FakeElement("a", null, {
        href: "/profile",
        "aria-label": "Profile"
    });
    link.href = "https://example.test/profile";
    const hiddenButton = new FakeButton(null);
    hiddenButton.visible = false;
    hiddenButton.setAttribute("aria-label", "Hidden action");
    const disabledButton = new FakeButton(null);
    disabledButton.disabled = true;
    disabledButton.setAttribute("type", "button");
    disabledButton.setAttribute("aria-label", "Disabled action");
    harness.setCandidates([...harness.candidates, link, hiddenButton, disabledButton]);

    const response = harness.send({ type: "OBSERVE_PAGE" });
    const elements = response.observation.interactiveElements;
    const button = elements.find(element => element.submit_button);
    const observedLink = elements.find(element => element.label === "Profile");
    const observedHiddenButton = elements.find(element => element.label === "Hidden action");
    const observedDisabledButton = elements.find(element => element.label === "Disabled action");

    assert.equal(button.visible, true);
    assert.equal(button.disabled, false);
    assert.equal(observedLink.visible, true);
    assert.equal(observedLink.disabled, false);
    assert.equal(observedLink.href, link.href);
    assert.equal(observedHiddenButton.visible, false);
    assert.equal(observedHiddenButton.disabled, false);
    assert.equal(observedDisabledButton.visible, true);
    assert.equal(observedDisabledButton.disabled, true);
});

test("observations report disabled inputs and keep them out of search candidates", () => {
    const harness = createHarness();
    harness.input.disabled = true;

    const response = harness.send({ type: "OBSERVE_PAGE" });
    const input = response.observation.interactiveElements.find(
        element => element.type === "input (text)"
    );

    assert.equal(input.visible, true);
    assert.equal(input.disabled, true);
    assert.equal(input.searchable, false);
});

test("observations include accessible semantics and nearest generic landmark context", () => {
    const harness = createHarness();
    const sidebar = new FakeElement("aside", null, { "aria-label": "Sidebar" });
    const navigation = new FakeElement("nav", null, {
        "aria-label": "Primary navigation"
    });
    const shortsLink = new FakeElement("a", null, {
        href: "/shorts/",
        "aria-label": "Shorts"
    });
    sidebar.parentElement = null;
    navigation.parentElement = sidebar;
    shortsLink.parentElement = navigation;
    shortsLink.href = "https://example.test/shorts/";
    harness.setCandidates([...harness.candidates, shortsLink]);

    const response = harness.send({ type: "OBSERVE_PAGE" });
    const descriptor = response.observation.interactiveElements.find(
        element => element.label === "Shorts"
    );

    assert.equal(descriptor.target_id.startsWith("target-"), true);
    assert.equal(descriptor.element_tag, "a");
    assert.equal(descriptor.accessible_role, "link");
    assert.equal(descriptor.accessible_name, "Shorts");
    assert.equal(descriptor.landmark_label, "Primary navigation");
    assert.deepEqual(JSON.parse(JSON.stringify(descriptor.ancestor_context)), [
        "nav: Primary navigation",
        "aside: Sidebar"
    ]);
});

test("a fresh observation includes dynamically added controls and replaces old target IDs", () => {
    const harness = createHarness();
    const previousTargetId = harness.observation.interactiveElements[0].target_id;
    const addedButton = new FakeButton(null);
    addedButton.setAttribute("type", "button");
    addedButton.setAttribute("aria-label", "Dynamically added action");
    harness.setCandidates([...harness.candidates, addedButton]);

    const response = harness.send({ type: "OBSERVE_PAGE" });
    const addedDescriptor = response.observation.interactiveElements.find(
        element => element.label === "Dynamically added action"
    );

    assert.equal(addedDescriptor.visible, true);
    assert.match(addedDescriptor.target_id, /^target-[0-9a-f-]{36}$/);
    assert.notEqual(addedDescriptor.target_id, previousTargetId);
    assert.equal(
        harness.context.aiBrowserSearchTargetStore.targets.has(previousTargetId),
        false
    );
});

test("execution rejects detached targets", () => {
    const harness = createHarness();
    harness.input.isConnected = false;

    const result = harness.send(harness.executeMessage);

    assert.equal(result.ok, false);
    assert.match(result.error, /no longer attached/i);
    assert.equal(harness.form.submitCalls.length, 0);
});

test("execution rejects expired targets", () => {
    const harness = createHarness();
    const targetId = harness.executeMessage.inputTargetId;
    vm.runInContext(
        `globalThis.aiBrowserSearchTargetStore.targets.get("${targetId}").createdAt = 0`,
        harness.context
    );

    const result = harness.send(harness.executeMessage);

    assert.equal(result.ok, false);
    assert.match(result.error, /expired or is unavailable/i);
    assert.equal(harness.form.submitCalls.length, 0);
});

test("execution rejects invalid target IDs without resolving selectors", () => {
    const harness = createHarness();
    const result = harness.send({
        ...harness.executeMessage,
        inputTargetId: 'input[name="q"]'
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /target ID is invalid/i);
    assert.equal(harness.form.submitCalls.length, 0);
});

test("execution rejects modified targets while ignoring positional changes", () => {
    const harness = createHarness();
    for (const [attribute, value] of [
        ["name", "other"],
        ["aria-label", "Different search"]
    ]) {
        const modifiedHarness = createHarness();
        modifiedHarness.input.setAttribute(attribute, value);
        const result = modifiedHarness.send(modifiedHarness.executeMessage);

        assert.equal(result.ok, false, `${attribute} was accepted`);
        assert.match(result.error, /changed since observation/i);
        assert.equal(modifiedHarness.form.submitCalls.length, 0);
    }
});

test("execution rejects hidden and disabled targets", () => {
    const hiddenHarness = createHarness();
    hiddenHarness.input.visible = false;
    const hiddenResult = hiddenHarness.send(hiddenHarness.executeMessage);
    assert.equal(hiddenResult.ok, false);
    assert.match(hiddenResult.error, /no longer visible/i);

    const disabledHarness = createHarness();
    disabledHarness.input.disabled = true;
    const disabledResult = disabledHarness.send(disabledHarness.executeMessage);
    assert.equal(disabledResult.ok, false);
    assert.match(disabledResult.error, /disabled/i);
});

test("execution rejects changed form security attributes and mismatched submit forms", () => {
    for (const [attribute, value] of [
        ["method", "post"],
        ["action", "https://other.example/search"],
        ["target", "_blank"]
    ]) {
        const changedFormHarness = createHarness();
        changedFormHarness.form.attributes.set(attribute, value);
        const changedFormResult = changedFormHarness.send(changedFormHarness.executeMessage);
        assert.equal(changedFormResult.ok, false, `${attribute} was accepted`);
        assert.match(changedFormResult.error, /changed since observation/i);
        assert.equal(changedFormHarness.form.submitCalls.length, 0);
    }

    const unrelatedButtonHarness = createHarness();
    const unrelatedForm = new FakeForm();
    const unrelatedButton = new FakeButton(unrelatedForm);
    unrelatedButtonHarness.setCandidates([
        unrelatedButtonHarness.input,
        unrelatedButton
    ]);
    const unrelatedObservation = unrelatedButtonHarness.send({ type: "OBSERVE_PAGE" });
    const unrelatedInputDescriptor = unrelatedObservation.observation.interactiveElements.find(
        element => element.type === "input (text)"
    );
    const unrelatedSubmitDescriptor = unrelatedObservation.observation.interactiveElements.find(
        element => element.submit_button
    );
    const mismatchResult = unrelatedButtonHarness.send({
        ...unrelatedButtonHarness.executeMessage,
        inputTargetId: unrelatedInputDescriptor.target_id,
        submitTargetId: unrelatedSubmitDescriptor.target_id
    });
    assert.equal(mismatchResult.ok, false);
    assert.match(mismatchResult.error, /does not belong to the search form/i);
});

test("target IDs are single-use and reject duplicate execution", () => {
    const harness = createHarness();

    const firstResult = harness.send(harness.executeMessage);
    const duplicateResult = harness.send(harness.executeMessage);

    assert.equal(firstResult.ok, true, JSON.stringify(firstResult));
    assert.equal(duplicateResult.ok, false);
    assert.match(duplicateResult.error, /expired or is unavailable/i);
    assert.equal(harness.form.submitCalls.length, 1);
});

test("page invalidation discards all previously issued target IDs", () => {
    const harness = createHarness();

    const invalidation = harness.send({ type: "INVALIDATE_SEARCH_TARGETS" });
    const result = harness.send(harness.executeMessage);

    assert.equal(invalidation.ok, true);
    assert.equal(result.ok, false);
    assert.match(result.error, /expired or is unavailable/i);
    assert.equal(harness.form.submitCalls.length, 0);
});

test("pagehide discards target IDs and reinjection does not duplicate listeners", () => {
    const harness = createHarness();
    const pagehide = harness.windowListeners.find(listener => listener.type === "pagehide");

    assert.ok(pagehide);
    assert.equal(harness.runtimeListenerCount(), 1);
    assert.equal(pagehide.options.once, true);
    pagehide.listener();
    const result = harness.send(harness.executeMessage);
    assert.equal(result.ok, false);
    assert.match(result.error, /expired or is unavailable/i);

    harness.installAgain();
    assert.equal(harness.windowListeners.length, 1);
    assert.equal(harness.runtimeListenerCount(), 1);
});

test("execution revalidates the target after page input handlers run", () => {
    const harness = createHarness();
    const dispatchEvent = harness.input.dispatchEvent.bind(harness.input);
    harness.input.dispatchEvent = event => {
        dispatchEvent(event);
        if (event.type === "input") {
            harness.form.attributes.set("action", "https://other.example/search");
        }
        return true;
    };

    const result = harness.send(harness.executeMessage);

    assert.equal(result.ok, false);
    assert.match(result.error, /changed since observation/i);
    assert.equal(harness.form.submitCalls.length, 0);
    assert.equal(harness.errors.length, 1);
});

function observeClickTarget(element) {
    const harness = createHarness();
    harness.setCandidates([element]);
    const response = harness.send({ type: "OBSERVE_PAGE" });
    const descriptor = response.observation.interactiveElements[0];
    const message = {
        type: "EXECUTE_APPROVED_CLICK",
        targetId: descriptor.target_id,
        expectedUrl: harness.window.location.href,
        expectedElementType: descriptor.type,
        expectedElementText: descriptor.label,
        expectedHref: descriptor.href ?? null,
        approvalExpiresAt: Date.now() + 30_000
    };
    return { harness, descriptor, message, element };
}

test("approved click dispatches a safe navigation link once", () => {
    const link = new FakeElement("a", null, {
        href: "/profile",
        "aria-label": "Profile"
    });
    link.href = "https://www.udemy.com/profile";
    const { harness, message, element } = observeClickTarget(link);

    const result = harness.send(message);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.status, "dispatched");
    assert.equal(element.clickCalls, 1);
    assert.equal(
        harness.context.aiBrowserSearchTargetStore.targets.has(message.targetId),
        false
    );
});

test("approved click dispatches a safe non-submit button", () => {
    const button = new FakeButton(null);
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "Open preferences");
    const { harness, message, element } = observeClickTarget(button);

    const result = harness.send(message);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(element.clickCalls, 1);
});

test("approved click dispatches an anchor-backed navigation tab with a safe href", () => {
    const tab = new FakeElement("a", null, {
        href: "/settings",
        role: "tab",
        "aria-label": "Settings"
    });
    tab.href = "https://www.udemy.com/settings";
    const { harness, descriptor, message, element } = observeClickTarget(tab);

    assert.equal(descriptor.type, "tab");
    assert.equal(message.expectedHref, tab.href);
    const result = harness.send(message);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(element.clickCalls, 1);
});

test("approved click applies link safety to anchor elements with button roles", () => {
    const anchorButton = new FakeElement("a", null, {
        href: "/open",
        role: "button",
        "aria-label": "Open page"
    });
    anchorButton.href = "javascript:alert(1)";
    const { harness, message, element } = observeClickTarget(anchorButton);

    const result = harness.send(message);

    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP or HTTPS/i);
    assert.equal(element.clickCalls, 0);
});

test("approved click consumes its target before click handlers can re-enter", () => {
    const button = new FakeButton(null);
    button.setAttribute("type", "button");
    button.setAttribute("aria-label", "Open preferences");
    const { harness, message, element } = observeClickTarget(button);
    let duplicateResult;
    element.click = () => {
        element.clickCalls += 1;
        duplicateResult = harness.send(message);
    };

    const result = harness.send(message);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(element.clickCalls, 1);
    assert.equal(duplicateResult.ok, false);
    assert.match(duplicateResult.error, /stale or unavailable/i);
});

test("approved click rejects a missing target", () => {
    const button = new FakeButton(null);
    button.setAttribute("type", "button");
    const { harness, message } = observeClickTarget(button);
    message.targetId = "target-00000000-0000-4000-8000-000000000099";

    const result = harness.send(message);

    assert.equal(result.ok, false);
    assert.match(result.error, /stale or unavailable/i);
    assert.equal(button.clickCalls, 0);
});

test("approved click rejects detached nodes and targets from another document", () => {
    const detachedButton = new FakeButton(null);
    detachedButton.setAttribute("type", "button");
    const detached = observeClickTarget(detachedButton);
    detachedButton.isConnected = false;
    const detachedResult = detached.harness.send(detached.message);
    assert.equal(detachedResult.ok, false);
    assert.match(detachedResult.error, /no longer attached/i);
    assert.equal(detachedButton.clickCalls, 0);

    const otherDocumentButton = new FakeButton(null);
    otherDocumentButton.setAttribute("type", "button");
    const otherDocument = observeClickTarget(otherDocumentButton);
    otherDocument.harness.context.aiBrowserSearchTargetStore.targets
        .get(otherDocument.message.targetId).documentToken = {};
    const documentResult = otherDocument.harness.send(otherDocument.message);
    assert.equal(documentResult.ok, false);
    assert.match(documentResult.error, /another document/i);
    assert.equal(otherDocumentButton.clickCalls, 0);
});

test("approved click rejects stale, hidden, and disabled targets", () => {
    const stale = observeClickTarget(new FakeButton(null));
    stale.harness.send({ type: "INVALIDATE_SEARCH_TARGETS" });
    const staleResult = stale.harness.send(stale.message);
    assert.equal(staleResult.ok, false);
    assert.match(staleResult.error, /stale or unavailable/i);

    const hiddenButton = new FakeButton(null);
    hiddenButton.setAttribute("type", "button");
    const hidden = observeClickTarget(hiddenButton);
    hidden.element.visible = false;
    const hiddenResult = hidden.harness.send(hidden.message);
    assert.equal(hiddenResult.ok, false);
    assert.match(hiddenResult.error, /no longer visible/i);
    assert.equal(hidden.element.clickCalls, 0);

    const disabledButton = new FakeButton(null);
    disabledButton.setAttribute("type", "button");
    const disabled = observeClickTarget(disabledButton);
    disabled.element.disabled = true;
    const disabledResult = disabled.harness.send(disabled.message);
    assert.equal(disabledResult.ok, false);
    assert.match(disabledResult.error, /disabled/i);
    assert.equal(disabled.element.clickCalls, 0);
});

test("approved click rejects identity changes, destructive targets, and form submits", () => {
    const changed = observeClickTarget(new FakeButton(null));
    changed.element.setAttribute("type", "button");
    changed.element.setAttribute("aria-label", "Different action");
    const changedResult = changed.harness.send(changed.message);
    assert.equal(changedResult.ok, false);
    assert.match(changedResult.error, /changed since observation/i);
    assert.equal(changed.element.clickCalls, 0);

    const destructiveButton = new FakeButton(null);
    destructiveButton.setAttribute("type", "button");
    destructiveButton.setAttribute("aria-label", "Delete account");
    const destructive = observeClickTarget(destructiveButton);
    const destructiveResult = destructive.harness.send(destructive.message);
    assert.equal(destructiveResult.ok, false);
    assert.match(destructiveResult.error, /destructive or transaction-related/i);
    assert.equal(destructiveButton.clickCalls, 0);

    const submitButton = new FakeButton(new FakeForm());
    const submit = observeClickTarget(submitButton);
    const submitResult = submit.harness.send(submit.message);
    assert.equal(submitResult.ok, false);
    assert.match(submitResult.error, /form submission/i);
    assert.equal(submitButton.clickCalls, 0);

    const unattachedSubmitButton = new FakeButton(null);
    const unattachedSubmit = observeClickTarget(unattachedSubmitButton);
    const unattachedSubmitResult = unattachedSubmit.harness.send(unattachedSubmit.message);
    assert.equal(unattachedSubmitResult.ok, false);
    assert.match(unattachedSubmitResult.error, /form submission/i);
    assert.equal(unattachedSubmitButton.clickCalls, 0);
});

test("approved click rejects unsafe or changed link destinations", () => {
    const unsafeLink = new FakeElement("a", null, { href: "/safe" });
    unsafeLink.href = "javascript:alert(1)";
    const unsafe = observeClickTarget(unsafeLink);
    const unsafeResult = unsafe.harness.send(unsafe.message);
    assert.equal(unsafeResult.ok, false);
    assert.match(unsafeResult.error, /HTTP or HTTPS/i);
    assert.equal(unsafeLink.clickCalls, 0);

    const changedLink = new FakeElement("a", null, { href: "/safe" });
    changedLink.href = "https://www.udemy.com/safe";
    const changed = observeClickTarget(changedLink);
    changedLink.href = "https://other.example/unsafe";
    const changedResult = changed.harness.send(changed.message);
    assert.equal(changedResult.ok, false);
    assert.match(changedResult.error, /changed since observation/i);
    assert.equal(changedLink.clickCalls, 0);
});

test("approved click rejects expired approvals and document URL mismatches", () => {
    const expired = observeClickTarget(new FakeButton(null));
    expired.element.setAttribute("type", "button");
    expired.message.approvalExpiresAt = Date.now() - 1;
    const expiredResult = expired.harness.send(expired.message);
    assert.equal(expiredResult.ok, false);
    assert.match(expiredResult.error, /expired/i);
    assert.equal(expired.element.clickCalls, 0);

    const wrongUrl = observeClickTarget(new FakeButton(null));
    wrongUrl.element.setAttribute("type", "button");
    wrongUrl.message.expectedUrl = "https://www.udemy.com/another-document";
    const wrongUrlResult = wrongUrl.harness.send(wrongUrl.message);
    assert.equal(wrongUrlResult.ok, false);
    assert.match(wrongUrlResult.error, /different page/i);
    assert.equal(wrongUrl.element.clickCalls, 0);
});
