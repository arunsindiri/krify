if (!(globalThis.aiBrowserSearchTargetStore?.targets instanceof Map)) {
    globalThis.aiBrowserSearchTargetStore = { targets: new Map() };
}

if (!globalThis.aiBrowserObserverInstalled) {
    globalThis.aiBrowserObserverInstalled = true;
    window.addEventListener("pagehide", () => {
        globalThis.aiBrowserSearchTargetStore.targets.clear();
    }, { once: true });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === "INVALIDATE_SEARCH_TARGETS") {
            globalThis.aiBrowserSearchTargetStore.targets.clear();
            sendResponse({ ok: true });
            return false;
        }

        if (message?.type !== "OBSERVE_PAGE") {
            if (message?.type !== "EXECUTE_SEARCH") {
                return false;
            }

            try {
                const search = prepareSearch(message);
                setTimeout(() => {
                    try {
                        submitSearch(search);
                        sendResponse({
                            ok: true,
                            result: {
                                message: `Search request initiated for "${search.query}".`,
                                query: search.query
                            }
                        });
                    } catch (error) {
                        console.error("Unable to submit the confirmed search:", error);
                        sendResponse({
                            ok: false,
                            error: error.message || "Unable to submit the search."
                        });
                    }
                }, 0);
            } catch (error) {
                sendResponse({
                    ok: false,
                    error: error.message || "Unable to submit the search."
                });
            }

            return true;
        }

        const visibleText = document.body?.innerText || "";
        const interactiveElements = collectInteractiveElements();
        const searchResultEvidence = collectSearchResultEvidence();

        sendResponse({
            observation: {
                title: document.title,
                url: window.location.href,
                visibleText: visibleText.slice(0, 12000),
                visibleTextTruncated: visibleText.length > 12000,
                interactiveElements: interactiveElements.descriptors,
                interactiveElementsTruncated: interactiveElements.truncated,
                searchResultContainerCount: searchResultEvidence.containerCount,
                searchResultLinks: searchResultEvidence.links
            }
        });

        return false;
    });
}

function collectInteractiveElements() {
    const targetStore = globalThis.aiBrowserSearchTargetStore.targets;
    targetStore.clear();
    const candidates = document.querySelectorAll(
        'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="searchbox"]'
    );
    const descriptors = [];
    let truncated = false;

    for (const element of candidates) {
        const style = window.getComputedStyle(element);
        if (
            element.getClientRects().length === 0 ||
            style.visibility === "hidden" ||
            style.display === "none" ||
            style.opacity === "0"
        ) {
            continue;
        }

        if (descriptors.length >= 100) {
            truncated = true;
            break;
        }

        const tagName = element.tagName.toLowerCase();
        const role = element.getAttribute("role");
        const inputType = tagName === "input" ? (element.type || "text").toLowerCase() : null;
        const type = tagName === "input"
            ? `input (${inputType})`
            : role || tagName;
        const label = getElementLabel(element);
        const placeholderValue = element.getAttribute("placeholder");
        const name = element.getAttribute("name");
        const elementId = element.getAttribute("id");
        const searchMetadata = [
            type,
            label,
            placeholderValue,
            name,
            elementId,
            element.getAttribute("autocomplete")
        ].filter(Boolean).join(" ");
        const formIndex = element.form
            ? Array.prototype.indexOf.call(document.forms, element.form)
            : -1;
        const formAction = element.form?.getAttribute("action") || window.location.href;
        const formMethod = (element.form?.getAttribute("method") || "get").toLowerCase();
        const formTarget = (element.form?.getAttribute("target") || "").toLowerCase();
        const formUrl = resolveFormUrl(formAction);
        const safeSearchForm = Boolean(
            element.form &&
            formMethod === "get" &&
            (!formTarget || formTarget === "_self") &&
            ["http:", "https:"].includes(window.location.protocol) &&
            formUrl?.protocol === window.location.protocol &&
            formUrl.origin === window.location.origin
        );
        const searchCandidate = tagName === "input" &&
            ["search", "text"].includes(inputType) &&
            (inputType === "search" ||
                role === "searchbox" ||
                /\b(search|query)\b/i.test(searchMetadata));
        let searchRejectionReason = null;
        if (searchCandidate) {
            if (formIndex < 0) {
                searchRejectionReason = "search input is not associated with a form";
            } else if (formMethod !== "get") {
                searchRejectionReason = `form method is ${formMethod.toUpperCase()}, not GET`;
            } else if (formTarget && formTarget !== "_self") {
                searchRejectionReason = "form target is not the current page";
            } else if (!["http:", "https:"].includes(window.location.protocol)) {
                searchRejectionReason = "page does not use HTTP or HTTPS";
            } else if (!formUrl || formUrl.origin !== window.location.origin) {
                searchRejectionReason = "form action is not same-origin";
            } else if (formUrl.protocol !== window.location.protocol) {
                searchRejectionReason = "form action uses a different protocol";
            } else if (element.disabled || element.readOnly || element.matches(":disabled")) {
                searchRejectionReason = "search input is disabled or read-only";
            }
        }
        const searchable = searchCandidate && !searchRejectionReason;
        const hasSubmitOverrides = [
            "formaction",
            "formmethod",
            "formtarget",
            "formenctype"
        ].some(attribute => element.getAttribute(attribute) !== null);
        const submitButton = formIndex >= 0 &&
            !hasSubmitOverrides &&
            !element.disabled &&
            !element.matches(":disabled") && (
            (tagName === "button" && element.type === "submit") ||
            (tagName === "input" && ["submit", "image"].includes(inputType))
        );
        const descriptor = {
            index: descriptors.length,
            target_id: registerSearchTarget(element),
            type,
            label,
            search_candidate: searchCandidate,
            searchable,
            search_rejection_reason: searchRejectionReason,
            form_index: formIndex >= 0 ? formIndex : null,
            submit_button: submitButton
        };

        if (inputType) {
            descriptor.input_type = inputType;
        }

        if (placeholderValue) {
            descriptor.placeholder = placeholderValue.slice(0, 200);
        }

        if (name) {
            descriptor.name = name.slice(0, 200);
        }

        if (elementId) {
            descriptor.element_id = elementId.slice(0, 200);
        }

        if (searchCandidate) {
            descriptor.search_value = element.value.slice(0, 300);
        }

        if (tagName === "a") {
            descriptor.href = element.href;
        }

        descriptors.push(descriptor);
    }

    return {
        descriptors,
        truncated
    };
}

function registerSearchTarget(element) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    const uuid = [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20)
    ].join("-");
    const targetId = `target-${uuid}`;
    globalThis.aiBrowserSearchTargetStore.targets.set(targetId, {
        targetId,
        element,
        observedUrl: window.location.href,
        createdAt: Date.now(),
        snapshot: {
            tagName: element.tagName,
            type: element.type || "",
            name: element.getAttribute("name"),
            id: element.getAttribute("id"),
            ariaLabel: element.getAttribute("aria-label"),
            title: element.getAttribute("title"),
            label: getElementLabel(element),
            placeholder: element.getAttribute("placeholder"),
            role: element.getAttribute("role"),
            autocomplete: element.getAttribute("autocomplete"),
            form: element.form || null,
            formAction: element.form?.getAttribute("action") ?? null,
            formMethod: element.form?.getAttribute("method") ?? null,
            formTarget: element.form?.getAttribute("target") ?? null
        }
    });
    return targetId;
}

function collectSearchResultEvidence() {
    const containers = new Set(document.querySelectorAll(
        'article, [role="article"], [role="feed"], [data-testid*="result" i], ' +
        '[class*="result" i], [id*="result" i], [class*="renderer" i], ' +
        '[id*="renderer" i], [data-testid*="renderer" i], [class*="card" i], ' +
        '[id*="card" i], [data-testid*="card" i]'
    ));

    const visibleContainers = Array.from(containers).filter(element => {
        const style = window.getComputedStyle(element);
        return element.getClientRects().length > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            style.opacity !== "0" &&
            (element.innerText || element.textContent || "").trim().length >= 20;
    });
    const links = new Map();

    for (const container of visibleContainers) {
        for (const link of container.querySelectorAll("a[href]")) {
            const style = window.getComputedStyle(link);
            if (
                link.getClientRects().length === 0 ||
                style.visibility === "hidden" ||
                style.display === "none" ||
                style.opacity === "0"
            ) {
                continue;
            }

            const text = (
                link.innerText ||
                link.getAttribute("aria-label") ||
                link.getAttribute("title") ||
                ""
            ).trim().replace(/\s+/g, " ").slice(0, 200);
            const href = link.href.slice(0, 2048);
            if (href && (text || link.getClientRects().length > 0)) {
                links.set(href, { text, href });
            }
        }
    }

    return {
        containerCount: Math.min(visibleContainers.length, 500),
        links: Array.from(links.values()).slice(0, 50)
    };
}

function getElementLabel(element) {
    return (
        element.getAttribute("aria-label") ||
        Array.from(element.labels || [])
            .map(labelElement => labelElement.innerText || labelElement.textContent || "")
            .join(" ") ||
        element.innerText ||
        element.textContent ||
        element.getAttribute("title") ||
        ""
    ).trim().replace(/\s+/g, " ").slice(0, 200);
}

function prepareSearch(message) {
    const query = typeof message.query === "string" ? message.query.trim() : "";
    if (!query || query.length > 300) {
        throw new Error("Enter a search query of 1 to 300 characters.");
    }

    if (message.expectedUrl !== window.location.href) {
        throw new Error("The webpage changed since observation. Observe the page again and retry.");
    }

    const inputTarget = resolveSearchTarget(message.inputTargetId, "search field");
    const input = inputTarget.element;
    validateSearchInputTarget(inputTarget);

    let submitTarget = null;
    if (message.submitTargetId !== null && message.submitTargetId !== undefined) {
        submitTarget = resolveSearchTarget(message.submitTargetId, "submit button");
        validateSubmitTarget(submitTarget);
        if (submitTarget.snapshot.form !== input.form) {
            throw new Error("The selected submit button does not belong to the search form.");
        }
    }

    const form = validateSearchForm(input, message.expectedUrl);
    if (submitTarget && submitTarget.element.form !== form) {
        throw new Error("The selected submit button does not belong to the search form.");
    }
    if (submitTarget) {
        validateSubmitTarget(submitTarget);
    }

    const valueSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value"
    )?.set;
    if (!valueSetter) {
        throw new Error("The search field cannot be updated safely.");
    }

    globalThis.aiBrowserSearchTargetStore.targets.delete(message.inputTargetId);
    if (message.submitTargetId) {
        globalThis.aiBrowserSearchTargetStore.targets.delete(message.submitTargetId);
    }
    valueSetter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    return {
        form,
        query,
        inputTarget,
        submitTarget,
        expectedUrl: message.expectedUrl
    };
}

function validateSearchForm(input, expectedUrl) {
    if (expectedUrl !== window.location.href) {
        throw new Error("The webpage changed since observation. Observe the page again and retry.");
    }

    const form = input.form;
    if (!form) {
        throw new Error("The selected search field is no longer associated with a form.");
    }

    const formMethod = (form.getAttribute("method") || "get").toLowerCase();
    const formTarget = (form.getAttribute("target") || "").toLowerCase();
    const formAction = form.getAttribute("action") || window.location.href;
    const formUrl = resolveFormUrl(formAction);
    if (formMethod !== "get") {
        throw new Error("The search form is not a GET form.");
    }

    if (formTarget && formTarget !== "_self") {
        throw new Error("The search form does not target the current page.");
    }

    if (!["http:", "https:"].includes(window.location.protocol)) {
        throw new Error("Search is only supported on HTTP or HTTPS webpages.");
    }

    if (!formUrl) {
        throw new Error("The search form action is invalid.");
    }

    if (formUrl.protocol !== window.location.protocol) {
        throw new Error("The search form action uses a different protocol.");
    }

    if (formUrl.origin !== window.location.origin) {
        throw new Error("The search form action is not same-origin.");
    }

    return form;
}

function resolveSearchTarget(targetId, description) {
    if (typeof targetId !== "string" || !/^target-[0-9a-f-]{36}$/.test(targetId)) {
        throw new Error(`The selected ${description} target ID is invalid.`);
    }

    const targets = globalThis.aiBrowserSearchTargetStore.targets;
    const target = targets.get(targetId);
    if (!target || Date.now() - target.createdAt > 5 * 60 * 1000) {
        targets.delete(targetId);
        throw new Error(
            `The selected ${description} target expired or is unavailable. Observe the page again and retry.`
        );
    }

    validateTargetState(target, description);
    return target;
}

function validateTargetState(target, description) {
    if (Date.now() - target.createdAt > 5 * 60 * 1000) {
        globalThis.aiBrowserSearchTargetStore.targets.delete(target.targetId);
        throw new Error(
            `The selected ${description} target expired. Observe the page again and retry.`
        );
    }

    if (
        target.observedUrl !== window.location.href ||
        !target.element.isConnected ||
        !document.documentElement.contains(target.element)
    ) {
        globalThis.aiBrowserSearchTargetStore.targets.delete(target.targetId);
        throw new Error(
            `The selected ${description} is no longer attached to the observed webpage. Observe the page again and retry.`
        );
    }

    if (!isVisibleElement(target.element)) {
        globalThis.aiBrowserSearchTargetStore.targets.delete(target.targetId);
        throw new Error(`The selected ${description} is no longer visible.`);
    }

    if (!matchesTargetSnapshot(target)) {
        globalThis.aiBrowserSearchTargetStore.targets.delete(target.targetId);
        throw new Error(
            `The selected ${description} changed since observation. Observe the page again and retry.`
        );
    }
}

function validateSearchInputTarget(target) {
    const input = target.element;
    const tagName = input.tagName.toLowerCase();
    const inputType = (input.type || "text").toLowerCase();
    const searchMetadata = [
        tagName === "input" ? `input (${inputType})` : input.getAttribute("role"),
        input.getAttribute("aria-label"),
        Array.from(input.labels || [])
            .map(label => label.innerText || label.textContent || "")
            .join(" "),
        input.innerText,
        input.textContent,
        input.getAttribute("title"),
        input.getAttribute("placeholder"),
        input.getAttribute("name"),
        input.getAttribute("id"),
        input.getAttribute("autocomplete")
    ].filter(Boolean).join(" ");
    const isSearchCandidate = tagName === "input" &&
        ["search", "text"].includes(inputType) &&
        (inputType === "search" ||
            input.getAttribute("role") === "searchbox" ||
            /\b(search|query)\b/i.test(searchMetadata));

    if (!isSearchCandidate) {
        throw new Error("The selected search field is no longer a supported search input.");
    }

    if (!input.form || input.form !== target.snapshot.form) {
        throw new Error("The selected search field no longer belongs to its observed form.");
    }

    if (input.disabled) {
        throw new Error("The selected search field is disabled.");
    }

    if (input.matches(":disabled")) {
        throw new Error("The selected search field is disabled by its form.");
    }

    if (input.readOnly) {
        throw new Error("The selected search field is read-only.");
    }

}

function validateSubmitTarget(target) {
    const element = target.element;
    const tagName = element.tagName.toLowerCase();
    const inputType = tagName === "input" ? (element.type || "").toLowerCase() : "";
    const hasSubmitOverrides = [
        "formaction",
        "formmethod",
        "formtarget",
        "formenctype"
    ].some(attribute => element.getAttribute(attribute) !== null);
    const isSubmitButton = !hasSubmitOverrides &&
        !element.disabled &&
        !element.matches(":disabled") &&
        ((tagName === "button" && element.type === "submit") ||
            (tagName === "input" && ["submit", "image"].includes(inputType)));

    if (!element.form || !isSubmitButton) {
        throw new Error("The selected submit button changed or is not safe to use.");
    }
}

function isVisibleElement(element) {
    const style = window.getComputedStyle(element);
    return element.getClientRects().length > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0";
}

function matchesTargetSnapshot(target) {
    const { element, snapshot } = target;
    return element.tagName === snapshot.tagName &&
        (element.type || "") === snapshot.type &&
        element.getAttribute("name") === snapshot.name &&
        element.getAttribute("id") === snapshot.id &&
        element.getAttribute("aria-label") === snapshot.ariaLabel &&
        element.getAttribute("title") === snapshot.title &&
        getElementLabel(element) === snapshot.label &&
        element.getAttribute("placeholder") === snapshot.placeholder &&
        element.getAttribute("role") === snapshot.role &&
        element.getAttribute("autocomplete") === snapshot.autocomplete &&
        (element.form || null) === snapshot.form &&
        (element.form?.getAttribute("action") ?? null) === snapshot.formAction &&
        (element.form?.getAttribute("method") ?? null) === snapshot.formMethod &&
        (element.form?.getAttribute("target") ?? null) === snapshot.formTarget;
}

function submitSearch(search) {
    validateTargetState(search.inputTarget, "search field");
    validateSearchInputTarget(search.inputTarget);
    const form = validateSearchForm(search.inputTarget.element, search.expectedUrl);
    if (form !== search.form) {
        throw new Error("The selected search field changed forms before submission.");
    }

    if (search.submitTarget) {
        validateTargetState(search.submitTarget, "submit button");
        validateSubmitTarget(search.submitTarget);
        if (search.submitTarget.element.form !== form) {
            throw new Error("The selected submit button does not belong to the search form.");
        }
    }

    const requestSubmit = HTMLFormElement.prototype.requestSubmit;
    if (search.submitTarget) {
        requestSubmit.call(form, search.submitTarget.element);
    } else {
        requestSubmit.call(form);
    }
}

function resolveFormUrl(action) {
    try {
        return new URL(action, window.location.href);
    } catch (error) {
        if (error instanceof TypeError) {
            return null;
        }
        throw error;
    }
}
