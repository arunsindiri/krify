if (!(globalThis.aiBrowserSearchTargetStore?.targets instanceof Map)) {
    globalThis.aiBrowserSearchTargetStore = { targets: new Map() };
}
if (!globalThis.aiBrowserTargetDocumentToken) {
    globalThis.aiBrowserTargetDocumentToken = {};
}

if (!globalThis.aiBrowserObserverInstalled) {
    globalThis.aiBrowserObserverInstalled = true;
    let pageMutationObserver = null;
    let pageChangeNotificationTimer = null;
    let pageChangeMonitoringEnabled = false;
    let lastObservedPageUrl = window.location.href;

    window.addEventListener("pagehide", () => {
        globalThis.aiBrowserSearchTargetStore.targets.clear();
    }, { once: true });
    installPageUrlChangeListeners();

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === "INVALIDATE_SEARCH_TARGETS") {
            globalThis.aiBrowserSearchTargetStore.targets.clear();
            sendResponse({ ok: true });
            return false;
        }

        if (message?.type === "PING_CLICK_EXECUTOR") {
            sendResponse({ ok: true });
            return false;
        }

        if (message?.type === "EXECUTE_APPROVED_CLICK") {
            try {
                const result = executeApprovedClick(message);
                sendResponse({ ok: true, result });
            } catch (error) {
                sendResponse({
                    ok: false,
                    error: error.message || "The page rejected the approved click."
                });
            }
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
        startPageChangeMonitoring();

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

    function installPageUrlChangeListeners() {
        for (const methodName of ["pushState", "replaceState"]) {
            const originalMethod = window.history?.[methodName];
            if (typeof originalMethod !== "function") {
                continue;
            }

            window.history[methodName] = function (...args) {
                const previousUrl = window.location.href;
                const result = Reflect.apply(originalMethod, this, args);
                notifyIfPageUrlChanged(previousUrl);
                return result;
            };
        }

        window.addEventListener("popstate", () => notifyIfPageUrlChanged());
        window.addEventListener("hashchange", () => notifyIfPageUrlChanged());
        window.navigation?.addEventListener(
            "currententrychange",
            () => notifyIfPageUrlChanged()
        );
    }

    function notifyIfPageUrlChanged(previousUrl = lastObservedPageUrl) {
        const currentUrl = window.location.href;
        if (currentUrl === previousUrl) {
            return;
        }

        lastObservedPageUrl = currentUrl;
        schedulePageContentChanged();
    }

    function startPageChangeMonitoring() {
        if (pageChangeMonitoringEnabled || typeof MutationObserver !== "function") {
            return;
        }

        const observationRoot = document.documentElement || document.body;
        if (!observationRoot) {
            return;
        }

        lastObservedPageUrl = window.location.href;
        pageMutationObserver = new MutationObserver(handlePageMutations);
        pageMutationObserver.observe(observationRoot, {
            attributes: true,
            attributeFilter: [
                "aria-disabled",
                "aria-hidden",
                "aria-label",
                "aria-labelledby",
                "autocomplete",
                "disabled",
                "formaction",
                "formmethod",
                "formtarget",
                "formenctype",
                "hidden",
                "href",
                "id",
                "name",
                "placeholder",
                "role",
                "title",
                "type"
            ],
            attributeOldValue: true,
            characterData: true,
            characterDataOldValue: true,
            childList: true,
            subtree: true
        });
        pageChangeMonitoringEnabled = true;
    }

    function handlePageMutations(records) {
        const changedAttributes = new Map();
        const changedTextNodes = new Map();
        const addedNodes = new Set();
        const removedNodes = new Set();

        for (const record of records) {
            if (isInsideExtensionUi(record.target)) {
                continue;
            }

            if (record.type === "attributes") {
                let targetAttributes = changedAttributes.get(record.target);
                if (!targetAttributes) {
                    targetAttributes = new Map();
                    changedAttributes.set(record.target, targetAttributes);
                }
                if (!targetAttributes.has(record.attributeName)) {
                    targetAttributes.set(record.attributeName, record.oldValue);
                }
            } else if (record.type === "characterData") {
                if (!changedTextNodes.has(record.target)) {
                    changedTextNodes.set(record.target, record.oldValue);
                }
            } else if (record.type === "childList") {
                for (const node of record.addedNodes) {
                    addedNodes.add(node);
                }
                for (const node of record.removedNodes) {
                    removedNodes.add(node);
                }
            }
        }

        for (const [element, attributes] of changedAttributes) {
            if (!element.isConnected || isInsideExtensionUi(element)) {
                continue;
            }
            for (const [attributeName, oldValue] of attributes) {
                if (oldValue !== element.getAttribute(attributeName)) {
                    schedulePageContentChanged();
                    return;
                }
            }
        }

        for (const [textNode, oldValue] of changedTextNodes) {
            if (
                !isInsideExtensionUi(textNode) &&
                oldValue !== textNode.nodeValue &&
                (hasMeaningfulText(oldValue) || hasMeaningfulText(textNode.nodeValue))
            ) {
                schedulePageContentChanged();
                return;
            }
        }

        for (const node of addedNodes) {
            if (
                node.isConnected !== false &&
                !isInsideExtensionUi(node) &&
                hasMeaningfulPageContent(node)
            ) {
                schedulePageContentChanged();
                return;
            }
        }

        for (const node of removedNodes) {
            if (
                !addedNodes.has(node) &&
                !isInsideExtensionUi(node) &&
                hasMeaningfulPageContent(node)
            ) {
                schedulePageContentChanged();
                return;
            }
        }
    }

    function hasMeaningfulPageContent(node) {
        if (!node || isInsideExtensionUi(node)) {
            return false;
        }
        if (node.nodeType === 3) {
            return hasMeaningfulText(node.nodeValue);
        }
        if (node.nodeType !== 1) {
            return false;
        }

        const tagName = node.tagName?.toLowerCase();
        if (["script", "style", "noscript", "template"].includes(tagName)) {
            return false;
        }
        if (node.matches?.(
            'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="searchbox"]'
        )) {
            return true;
        }
        return hasMeaningfulText(node.innerText || node.textContent);
    }

    function hasMeaningfulText(value) {
        return typeof value === "string" && value.trim().length > 0;
    }

    function isInsideExtensionUi(node) {
        let element = node?.nodeType === 1 ? node : node?.parentElement;
        while (element) {
            if (
                element.id === "ai-browser-assistant-ui" ||
                typeof element.getAttribute === "function" &&
                element.getAttribute("data-ai-browser-assistant-ui") !== null
            ) {
                return true;
            }
            element = element.parentElement;
        }
        return false;
    }

    function schedulePageContentChanged() {
        if (!pageChangeMonitoringEnabled) {
            return;
        }
        if (pageChangeNotificationTimer !== null) {
            window.clearTimeout(pageChangeNotificationTimer);
        }

        pageChangeNotificationTimer = window.setTimeout(() => {
            pageChangeNotificationTimer = null;
            void chrome.runtime.sendMessage({
                type: "PAGE_CONTENT_CHANGED",
                url: window.location.href
            }).catch(error => {
                console.debug("Page content change notification was unavailable:", error.message);
            });
        }, 250);
    }
}

function collectInteractiveElements() {
    const targetStore = globalThis.aiBrowserSearchTargetStore.targets;
    targetStore.clear();
    const candidates = Array.from(document.querySelectorAll(
        'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="searchbox"]'
    ));
    const visibilityByElement = new Map(
        candidates.map(element => [element, isVisibleElement(element)])
    );
    candidates.sort((left, right) =>
        Number(visibilityByElement.get(right)) - Number(visibilityByElement.get(left))
    );
    const descriptors = [];
    let truncated = false;

    for (const element of candidates) {
        if (descriptors.length >= 100) {
            truncated = true;
            break;
        }

        const visible = visibilityByElement.get(element) === true;
        const disabled = getElementDisabledState(element);
        const tagName = element.tagName.toLowerCase();
        const role = element.getAttribute("role");
        const inputType = tagName === "input" ? (element.type || "text").toLowerCase() : null;
        const type = tagName === "input"
            ? `input (${inputType})`
            : role || tagName;
        const label = getElementLabel(element);
        const accessibleName = getAccessibleName(element);
        const accessibleRole = getAccessibleRole(element);
        const ancestorContext = getSemanticAncestorContext(element);
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
            if (!visible) {
                searchRejectionReason = "search input is not visible";
            } else if (disabled !== false) {
                searchRejectionReason = disabled === true
                    ? "search input is disabled"
                    : "search input disabled state was not observed";
            } else if (element.readOnly) {
                searchRejectionReason = "search input is read-only";
            } else if (formIndex < 0) {
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
        const submitButton = visible &&
            disabled === false &&
            formIndex >= 0 &&
            !hasSubmitOverrides &&
            (
            (tagName === "button" && element.type === "submit") ||
            (tagName === "input" && ["submit", "image"].includes(inputType))
        );
        const descriptor = {
            index: descriptors.length,
            target_id: registerSearchTarget(element),
            type,
            label,
            element_tag: tagName,
            accessible_role: accessibleRole,
            accessible_name: accessibleName,
            landmark_label: ancestorContext.landmarkLabel,
            ancestor_context: ancestorContext.ancestors,
            visible,
            disabled,
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
        documentToken: globalThis.aiBrowserTargetDocumentToken,
        createdAt: Date.now(),
        snapshot: {
            tagName: element.tagName,
            type: element.type || "",
            name: element.getAttribute("name"),
            id: element.getAttribute("id"),
            ariaLabel: element.getAttribute("aria-label"),
            title: element.getAttribute("title"),
            label: getElementLabel(element),
            accessibleRole: getAccessibleRole(element),
            accessibleName: getAccessibleName(element),
            landmarkLabel: getSemanticAncestorContext(element).landmarkLabel,
            ancestorContext: getSemanticAncestorContext(element).ancestors,
            href: typeof element.href === "string" ? element.href : null,
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
        getLabelledByText(element) ||
        Array.from(element.labels || [])
            .map(labelElement => labelElement.innerText || labelElement.textContent || "")
            .join(" ") ||
        element.innerText ||
        element.textContent ||
        element.getAttribute("title") ||
        ""
    ).trim().replace(/\s+/g, " ").slice(0, 200);
}

function getAccessibleName(element) {
    return getElementLabel(element);
}

function getAccessibleRole(element) {
    const explicitRole = element.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicitRole) {
        return explicitRole.slice(0, 40);
    }

    const tagName = element.tagName.toLowerCase();
    if (tagName === "a" && element.getAttribute("href") !== null) {
        return "link";
    }
    if (tagName === "button") {
        return "button";
    }
    if (tagName === "textarea") {
        return "textbox";
    }
    if (tagName === "select") {
        return element.multiple ? "listbox" : "combobox";
    }
    if (tagName === "input") {
        const inputType = (element.type || "text").toLowerCase();
        if (inputType === "search") {
            return "searchbox";
        }
        if (["button", "submit", "image"].includes(inputType)) {
            return "button";
        }
        if (inputType === "checkbox" || inputType === "radio") {
            return inputType;
        }
        return "textbox";
    }

    return tagName.slice(0, 40);
}

function getLabelledByText(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (!labelledBy || typeof document.getElementById !== "function") {
        return "";
    }

    return labelledBy
        .trim()
        .split(/\s+/)
        .map(id => document.getElementById(id))
        .filter(Boolean)
        .map(labelElement => labelElement.innerText || labelElement.textContent || "")
        .join(" ")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 200);
}

function getExplicitContextName(element) {
    return (
        element.getAttribute("aria-label") ||
        getLabelledByText(element) ||
        element.getAttribute("title") ||
        ""
    ).trim().replace(/\s+/g, " ").slice(0, 160);
}

function getSemanticAncestorContext(element) {
    const landmarkRoles = new Set([
        "banner",
        "complementary",
        "contentinfo",
        "main",
        "navigation",
        "region",
        "search",
        "toolbar"
    ]);
    const landmarkTags = new Set(["aside", "footer", "header", "main", "nav"]);
    const ancestors = [];
    let landmarkLabel = null;

    for (let ancestor = element.parentElement; ancestor && ancestors.length < 4; ancestor = ancestor.parentElement) {
        const tagName = ancestor.tagName.toLowerCase();
        const role = ancestor.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase() || "";
        const name = getExplicitContextName(ancestor);
        const isLandmark = landmarkRoles.has(role) || landmarkTags.has(tagName);
        if (!isLandmark && !role && !name) {
            continue;
        }

        const parts = [role || tagName];
        if (name) {
            parts.push(name);
        }
        ancestors.push(parts.join(": ").slice(0, 180));

        if (isLandmark && landmarkLabel === null) {
            landmarkLabel = name || role || tagName;
        }
    }

    return {
        landmarkLabel,
        ancestors
    };
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

function executeApprovedClick(message) {
    const targetId = message.targetId;
    if (
        typeof targetId !== "string" ||
        !/^target-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(targetId)
    ) {
        throw new Error("The approved click target ID is invalid.");
    }
    if (
        typeof message.approvalExpiresAt !== "number" ||
        !Number.isFinite(message.approvalExpiresAt) ||
        Date.now() >= message.approvalExpiresAt ||
        message.approvalExpiresAt > Date.now() + 4 * 60 * 1000
    ) {
        throw new Error("The click approval is expired or has an invalid expiry.");
    }
    if (message.expectedUrl !== window.location.href) {
        throw new Error("The approved click belongs to a different page.");
    }

    const targets = globalThis.aiBrowserSearchTargetStore.targets;
    const target = targets.get(targetId);
    if (!target || Date.now() - target.createdAt > 4 * 60 * 1000) {
        targets.delete(targetId);
        throw new Error("The approved click target is stale or unavailable.");
    }

    validateTargetState(target, "click target");
    validateApprovedClickTarget(target, message);

    targets.delete(targetId);
    target.element.click();

    return {
        status: "dispatched",
        message: "Click event dispatched. The page outcome was not verified."
    };
}

function validateApprovedClickTarget(target, message) {
    const element = target.element;
    const tagName = element.tagName.toLowerCase();
    const inputType = tagName === "input" ? (element.type || "text").toLowerCase() : "";
    const observedType = tagName === "input"
        ? `input (${inputType})`
        : element.getAttribute("role") || tagName;
    const supportedTypes = new Set(["a", "link", "button", "tab", "input (button)"]);

    if (target.documentToken !== globalThis.aiBrowserTargetDocumentToken) {
        throw new Error("The approved target belongs to another document.");
    }
    if (
        !element.isConnected ||
        !document.documentElement.contains(element)
    ) {
        throw new Error("The approved click target is no longer attached to the page.");
    }
    if (!isVisibleElement(element)) {
        throw new Error("The approved click target is no longer visible.");
    }
    if (
        getElementDisabledState(element) !== false ||
        (typeof element.matches === "function" && element.matches(":disabled"))
    ) {
        throw new Error("The approved click target is disabled or its enabled state is unknown.");
    }
    if (!supportedTypes.has(observedType)) {
        throw new Error("The approved click target type is not supported.");
    }
    if (message.expectedElementType !== observedType) {
        throw new Error("The approved click target type changed since observation.");
    }
    if (
        typeof message.expectedElementText !== "string" ||
        message.expectedElementText !== getElementLabel(element)
    ) {
        throw new Error("The approved click target identity changed since observation.");
    }
    if (!matchesTargetSnapshot(target)) {
        throw new Error("The approved click target identity changed since observation.");
    }
    if (isFormSubmitControl(element)) {
        throw new Error("Form submission controls are not supported for approved clicks.");
    }
    if (isUnsafeClickTarget(element)) {
        throw new Error("The approved click target appears destructive or transaction-related.");
    }

    const hasAnchorHref = tagName === "a" && element.getAttribute("href") !== null;
    const requiresSafeHref = hasAnchorHref ||
        observedType === "a" ||
        observedType === "link";
    if (requiresSafeHref) {
        const href = typeof element.href === "string" ? element.href : "";
        if (typeof message.expectedHref !== "string" || href !== message.expectedHref) {
            throw new Error("The approved link destination changed since observation.");
        }

        let destination;
        try {
            destination = new URL(href, window.location.href);
        } catch {
            throw new Error("The approved link destination is invalid.");
        }
        if (
            !["http:", "https:"].includes(destination.protocol) ||
            !destination.hostname ||
            destination.username ||
            destination.password
        ) {
            throw new Error("Only safe HTTP or HTTPS links can be clicked.");
        }
    } else if (message.expectedHref !== null) {
        throw new Error("The approved non-link target contains an unexpected destination.");
    }
}

function isFormSubmitControl(element) {
    const tagName = element.tagName.toLowerCase();
    const inputType = tagName === "input" ? (element.type || "").toLowerCase() : "";
    return Boolean(
        element.form &&
        (
            (tagName === "button" && (element.type || "submit").toLowerCase() === "submit") ||
            (tagName === "input" && ["submit", "image"].includes(inputType))
        )
    );
}

function isUnsafeClickTarget(element) {
    const descriptiveText = [
        getElementLabel(element),
        element.getAttribute("title") || "",
        element.getAttribute("name") || ""
    ].join(" ");
    return /\b(delet\w*|remov\w*|destroy\w*|eras\w*|discard\w*|purchas\w*|buy|bought|payment|pay|check\s*out|checkout|logout|log\s*out|sign\s*out|unsubscribe\w*|cancel\s+(?:an?\s+)?(?:order|purchase|subscription|booking)|(?:close|terminate)\s+(?:an?\s+)?account|place\s+(?:an?\s+)?order)\b/i
        .test(descriptiveText);
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
    try {
        if (!element || element.isConnected === false || element.hidden) {
            return false;
        }

        const hasVisibleRect = Array.from(element.getClientRects()).some(rect =>
            rect.width > 0 && rect.height > 0
        );
        if (!hasVisibleRect) {
            return false;
        }

        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.hidden || ancestor.inert) {
                return false;
            }

            const style = window.getComputedStyle(ancestor);
            const opacity = Number.parseFloat(style.opacity);
            if (
                style.visibility === "hidden" ||
                style.visibility === "collapse" ||
                style.display === "none" ||
                style.contentVisibility === "hidden" ||
                !Number.isFinite(opacity) ||
                opacity <= 0
            ) {
                return false;
            }
        }

        if (
            typeof element.checkVisibility === "function" &&
            !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        ) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
}

function getElementDisabledState(element) {
    try {
        if (element.getAttribute("aria-disabled")?.trim().toLowerCase() === "true") {
            return true;
        }

        if (typeof element.matches === "function" && element.matches(":disabled")) {
            return true;
        }

        return typeof element.disabled === "boolean" ? element.disabled : false;
    } catch {
        return null;
    }
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
        getAccessibleRole(element) === snapshot.accessibleRole &&
        getAccessibleName(element) === snapshot.accessibleName &&
        getSemanticAncestorContext(element).landmarkLabel === snapshot.landmarkLabel &&
        JSON.stringify(getSemanticAncestorContext(element).ancestors) ===
            JSON.stringify(snapshot.ancestorContext) &&
        (typeof element.href === "string" ? element.href : null) === snapshot.href &&
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
