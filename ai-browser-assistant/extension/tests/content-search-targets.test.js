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
        return this.visible ? [{}] : [];
    }

    matches(selector) {
        return selector === ":disabled" && this.disabled;
    }

    dispatchEvent(event) {
        this.events.push(event.type);
        return true;
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
