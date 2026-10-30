if (!globalThis.aiBrowserObserverInstalled) {
    globalThis.aiBrowserObserverInstalled = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== "OBSERVE_PAGE") {
            if (message?.type !== "EXECUTE_SEARCH") {
                return false;
            }

            try {
                const search = prepareSearch(message);
                sendResponse({
                    ok: true,
                    result: {
                        message: `Search request initiated for "${search.query}".`,
                        query: search.query
                    }
                });
                setTimeout(() => {
                    try {
                        submitSearch(search);
                    } catch (error) {
                        console.error("Unable to submit the confirmed search:", error);
                    }
                }, 0);
            } catch (error) {
                sendResponse({
                    ok: false,
                    error: error.message || "Unable to submit the search."
                });
            }

            return false;
        }

        const visibleText = document.body?.innerText || "";
        const interactiveElements = collectInteractiveElements();

        sendResponse({
            observation: {
                title: document.title,
                url: window.location.href,
                visibleText: visibleText.slice(0, 12000),
                visibleTextTruncated: visibleText.length > 12000,
                interactiveElements: interactiveElements.descriptors,
                interactiveElementsTruncated: interactiveElements.truncated
            }
        });

        return false;
    });
}

function collectInteractiveElements() {
    const candidates = document.querySelectorAll(
        'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="searchbox"]'
    );
    const descriptors = [];
    const nodes = [];
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

        const tagName = element.tagName.toLowerCase();
        const role = element.getAttribute("role");
        const inputType = tagName === "input" ? (element.type || "text").toLowerCase() : null;
        const type = tagName === "input"
            ? `input (${inputType})`
            : role || tagName;
        const label = (
            element.getAttribute("aria-label") ||
            Array.from(element.labels || []).map(labelElement => labelElement.innerText || labelElement.textContent || "").join(" ") ||
            element.innerText ||
            element.textContent ||
            element.getAttribute("title") ||
            ""
        ).trim().replace(/\s+/g, " ").slice(0, 200);
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

        if (tagName === "a") {
            descriptor.href = element.href;
        }

        descriptors.push(descriptor);
        nodes.push(element);
        if (descriptors.length > 100) {
            descriptors.pop();
            nodes.pop();
            truncated = true;
            break;
        }
    }

    return {
        descriptors,
        nodes,
        truncated
    };
}

function prepareSearch(message) {
    const query = typeof message.query === "string" ? message.query.trim() : "";
    if (!query || query.length > 300) {
        throw new Error("Enter a search query of 1 to 300 characters.");
    }

    const collection = collectInteractiveElements();
    const inputIndex = message.inputIndex;
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= collection.descriptors.length) {
        throw new Error("The selected search field is no longer available.");
    }

    const inputDescriptor = collection.descriptors[inputIndex];
    const input = collection.nodes[inputIndex];
    const formMethod = (input.form?.getAttribute("method") || "get").toLowerCase();
    const formTarget = (input.form?.getAttribute("target") || "").toLowerCase();
    const formAction = input.form?.getAttribute("action") || window.location.href;
    const formUrl = resolveFormUrl(formAction);
    if (
        message.expectedUrl !== window.location.href ||
        !inputDescriptor.searchable ||
        !matchesSnapshot(inputDescriptor, message.expectedInput) ||
        !input.form ||
        input.disabled ||
        input.matches(":disabled") ||
        input.readOnly ||
        !["search", "text"].includes(input.type.toLowerCase()) ||
        formMethod !== "get" ||
        (formTarget && formTarget !== "_self") ||
        !["http:", "https:"].includes(window.location.protocol) ||
        !formUrl ||
        formUrl.protocol !== window.location.protocol ||
        formUrl.origin !== window.location.origin
    ) {
        throw new Error("The selected search field changed or is not safe to use.");
    }

    let submitButton;
    if (message.submitIndex !== null && message.submitIndex !== undefined) {
        const submitIndex = message.submitIndex;
        if (!Number.isInteger(submitIndex) || submitIndex < 0 || submitIndex >= collection.descriptors.length) {
            throw new Error("The selected search button is no longer available.");
        }

        const submitDescriptor = collection.descriptors[submitIndex];
        submitButton = collection.nodes[submitIndex];
        if (
            !submitDescriptor.submit_button ||
            submitDescriptor.form_index !== inputDescriptor.form_index ||
            !matchesSnapshot(submitDescriptor, message.expectedSubmit) ||
            submitButton.form !== input.form ||
            submitButton.disabled ||
            submitButton.matches(":disabled")
        ) {
            throw new Error("The selected search button changed or does not belong to this search form.");
        }
    }

    const valueSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value"
    )?.set;
    if (!valueSetter) {
        throw new Error("The search field cannot be updated safely.");
    }

    valueSetter.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    return {
        form: input.form,
        query,
        submitButton
    };
}

function submitSearch(search) {
    const requestSubmit = HTMLFormElement.prototype.requestSubmit;
    if (search.submitButton) {
        requestSubmit.call(search.form, search.submitButton);
    } else {
        requestSubmit.call(search.form);
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

function matchesSnapshot(current, expected) {
    if (!expected) {
        return false;
    }

    return [
        "index",
        "type",
        "label",
        "placeholder",
        "searchable",
        "form_index",
        "submit_button",
        "input_type",
        "name",
        "element_id"
    ].every(key => (current[key] ?? null) === (expected[key] ?? null));
}
