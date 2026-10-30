const instructionInput = document.getElementById("instruction");
const runTaskButton = document.getElementById("runTask");
const resultDisplay = document.getElementById("result");
const observePageButton = document.getElementById("observePage");
const observationStatus = document.getElementById("observationStatus");
const observationDisplay = document.getElementById("observation");
const pageTitleDisplay = document.getElementById("pageTitle");
const pageUrlDisplay = document.getElementById("pageUrl");
const pageTextDisplay = document.getElementById("pageText");
const interactiveElementsDisplay = document.getElementById("interactiveElements");
const pageQuestionInput = document.getElementById("pageQuestion");
const askPageButton = document.getElementById("askPage");
const pageAnswerDisplay = document.getElementById("pageAnswer");
const clickInstructionInput = document.getElementById("clickInstruction");
const planClickButton = document.getElementById("planClick");
const clickResultDisplay = document.getElementById("clickResult");
const clickConfirmation = document.getElementById("clickConfirmation");
const clickConfirmationWebsite = document.getElementById("clickConfirmationWebsite");
const clickConfirmationAction = document.getElementById("clickConfirmationAction");
const clickConfirmationTarget = document.getElementById("clickConfirmationTarget");
const clickConfirmationType = document.getElementById("clickConfirmationType");
const clickConfirmationOutcome = document.getElementById("clickConfirmationOutcome");
const confirmClickButton = document.getElementById("confirmClick");
const cancelClickButton = document.getElementById("cancelClick");
const searchQueryInput = document.getElementById("searchQuery");
const searchPageButton = document.getElementById("searchPage");
const searchResultDisplay = document.getElementById("searchResult");
const searchConfirmation = document.getElementById("searchConfirmation");
const searchConfirmationWebsite = document.getElementById("searchConfirmationWebsite");
const searchConfirmationQuery = document.getElementById("searchConfirmationQuery");
const searchConfirmationInput = document.getElementById("searchConfirmationInput");
const searchConfirmationSubmit = document.getElementById("searchConfirmationSubmit");
const confirmSearchButton = document.getElementById("confirmSearch");
const cancelSearchButton = document.getElementById("cancelSearch");
const CLICK_TARGET_ID_PATTERN = /^target-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLICK_APPROVAL_MAX_AGE_MS = 4 * 60 * 1000;
let currentObservation = null;
let currentObservationAt = null;
let clickObservationInvalidated = false;
let activeTabContext = null;
let activeTabContextUpdate = 0;
let pendingSearchConfirmation = null;
let searchOperationInProgress = false;
let pendingClickConfirmation = null;
let approvedClickApproval = null;
let clickPlanningInProgress = false;
let clickConfirmationInProgress = false;
let clickPlanningTabId = null;
let clickPlanRequestVersion = 0;

chrome.tabs.onActivated.addListener((activeInfo) => {
    if (pendingSearchConfirmation?.tabId !== activeInfo.tabId) {
        discardPendingSearchConfirmation("The active tab changed.");
    }
    clickObservationInvalidated = true;
    invalidateClickState("The active tab changed.");
    void refreshActiveTabContext();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (
        pendingSearchConfirmation?.tabId === tabId &&
        (changeInfo.url || changeInfo.status === "complete")
    ) {
        discardPendingSearchConfirmation("The webpage changed.");
    }
    if (changeInfo.url || changeInfo.status === "loading" || changeInfo.status === "complete") {
        if (hasClickStateForTab(tabId) || tabId === activeTabContext?.tabId) {
            clickObservationInvalidated = true;
            invalidateClickState("The webpage changed.");
        }
    }
    if (changeInfo.url || changeInfo.status === "complete") {
        void refreshActiveTabContext();
    }
});
chrome.permissions.onAdded.addListener(() => {
    void refreshActiveTabContext();
});
chrome.permissions.onRemoved.addListener(() => {
    void refreshActiveTabContext();
});
chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "TOOLBAR_ACTIVE_TAB_GRANT_AVAILABLE") {
        void refreshActiveTabContext();
    }
    if (
        message?.type === "PAGE_OBSERVATION_INVALIDATED" ||
        message?.type === "PAGE_OBSERVATION_UPDATED" ||
        message?.type === "PAGE_OBSERVATION_FAILED"
    ) {
        void handlePageObservationLifecycleMessage(message);
    }
});
void refreshActiveTabContext();

async function handlePageObservationLifecycleMessage(message) {
    try {
        const [activeTab] = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true
        });
        if (activeTab?.id !== message.tabId) {
            return;
        }

        if (message.type === "PAGE_OBSERVATION_UPDATED") {
            await refreshActiveTabContext();
            if (
                activeTabContext?.tabId !== message.tabId ||
                activeTabContext.pageUrl?.href !== message.observation?.url
            ) {
                return;
            }

            displayObservation(message.observation);
            observationStatus.textContent = "Page observation refreshed after navigation.";
            return;
        }

        invalidateClickState(
            message.type === "PAGE_OBSERVATION_FAILED"
                ? "The page observation is no longer available."
                : "The webpage changed."
        );
        clickObservationInvalidated = true;
        currentObservation = null;
        currentObservationAt = null;
        observationDisplay.hidden = true;
        if (pendingSearchConfirmation) {
            discardPendingSearchConfirmation("The webpage navigated.");
        }
        observationStatus.textContent = message.type === "PAGE_OBSERVATION_FAILED"
            ? message.error || "Unable to refresh webpage observation."
            : "The webpage changed. Its observation will refresh after loading.";
        void refreshActiveTabContext();
    } catch (error) {
        console.error("Unable to update the Side Panel webpage observation", {
            tabId: message.tabId,
            error: error.message
        });
        if (message.type !== "PAGE_OBSERVATION_INVALIDATED") {
            observationStatus.textContent =
                `Unable to refresh webpage observation: ${error.message}`;
        }
    }
}

runTaskButton.addEventListener("click", async () => {
    const instruction = instructionInput.value.trim();

    if (!instruction) {
        resultDisplay.textContent = "Please enter an instruction.";
        return;
    }

    resultDisplay.textContent = "Processing your instruction...";

    try {
        const response = await fetch("http://127.0.0.1:8000/task", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                instruction: instruction
            })
        });

        if (!response.ok) {
            throw new Error(`Server returned status ${response.status}`);
        }

        const data = await response.json();

        if (data.action === "open_website") {
            resultDisplay.textContent = "Opening website in the active tab...";
            const navigation = await chrome.runtime.sendMessage({
                type: "NAVIGATE_ACTIVE_TAB",
                url: data.url
            });
            if (!navigation?.ok) {
                throw new Error(navigation?.error || "Unable to navigate the active tab.");
            }
            await refreshActiveTabContext();
            resultDisplay.textContent = data.message || "Opened website in the active tab.";
        } else {
            resultDisplay.textContent = data.message;
        }

    } catch (error) {
        resultDisplay.textContent =
            `Unable to run instruction: ${error.message}`;
    }
});

observePageButton.addEventListener("click", () => {
    observePageButton.disabled = true;
    const context = activeTabContext;
    if (!context) {
        observationStatus.textContent =
            "The active tab is still being identified. Wait a moment and click Observe active page again.";
        observePageButton.disabled = false;
        void refreshActiveTabContext();
        return;
    }
    if (!context.pageUrl) {
        observationStatus.textContent =
            "Chrome settings, the Chrome Web Store, and other protected browser pages cannot be observed.";
        observePageButton.disabled = false;
        return;
    }

    let permissionRequest = null;
    if (!context.hasOriginPermission && !context.hasActiveTabGrant) {
        const originPattern = `${context.pageUrl.origin}/*`;
        console.info("Requesting optional host permission", {
            tabId: context.tabId,
            origin: context.pageUrl.origin,
            pattern: originPattern
        });
        try {
            permissionRequest = chrome.permissions.request({
                origins: [originPattern]
            });
        } catch (error) {
            finishObservationError(error);
            return;
        }
    }

    return observeActiveTab(context, permissionRequest);
});

async function observeActiveTab(context, permissionRequest) {
    observationStatus.textContent = permissionRequest
        ? `Requesting access to ${context.pageUrl.hostname}...`
        : "Reading the active webpage...";

    try {
        if (permissionRequest) {
            let granted;
            try {
                granted = await permissionRequest;
            } catch (error) {
                console.error("Optional host permission request failed", {
                    tabId: context.tabId,
                    origin: context.pageUrl.origin,
                    error: error.message
                });
                throw error;
            }
            const originPattern = `${context.pageUrl.origin}/*`;
            const permissionPresent = await chrome.permissions.contains({
                origins: [originPattern]
            });
            console.info("Optional host permission result", {
                tabId: context.tabId,
                origin: context.pageUrl.origin,
                granted,
                permissionPresent
            });
            if (!granted || !permissionPresent) {
                if (!context.hasActiveTabGrant) {
                    throw new Error(
                        `Access to ${context.pageUrl.hostname} was denied. Grant this site's permission to observe its pages.`
                    );
                }
            }
        }

        const response = await observeTab(context.tabId, context.pageUrl.origin);
        if (!response?.ok) {
            throw new Error(response?.error || "Unable to observe the active webpage.");
        }

        displayObservation(response.observation);
        observationStatus.textContent = "Page observation complete.";
    } catch (error) {
        finishObservationError(error);
    } finally {
        observePageButton.disabled = false;
        void refreshActiveTabContext();
    }
}

function finishObservationError(error) {
    observationStatus.textContent = `Unable to observe this page: ${error.message}`;
    observePageButton.disabled = false;
}

async function refreshActiveTabContext() {
    const updateId = ++activeTabContextUpdate;
    try {
        const [activeTab] = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true
        });
        if (!Number.isInteger(activeTab?.id)) {
            activeTabContext = null;
            return;
        }

        let pageUrl;
        try {
            pageUrl = getObservablePageUrl(activeTab.url);
        } catch {
            activeTabContext = {
                tabId: activeTab.id,
                pageUrl: null,
                hasOriginPermission: false,
                hasActiveTabGrant: false
            };
            return;
        }

        const originPattern = `${pageUrl.origin}/*`;
        const [hasOriginPermission, access] = await Promise.all([
            chrome.permissions.contains({ origins: [originPattern] }),
            chrome.runtime.sendMessage({
                type: "GET_OBSERVATION_ACCESS",
                tabId: activeTab.id,
                origin: pageUrl.origin
            })
        ]);
        if (updateId !== activeTabContextUpdate) {
            return;
        }

        activeTabContext = {
            tabId: activeTab.id,
            pageUrl,
            hasOriginPermission,
            hasActiveTabGrant: Boolean(access?.activeTabGrant)
        };
        console.info("Active tab observation access", {
            tabId: activeTab.id,
            origin: pageUrl.origin,
            hasOriginPermission,
            hasActiveTabGrant: activeTabContext.hasActiveTabGrant
        });
    } catch (error) {
        if (updateId === activeTabContextUpdate) {
            activeTabContext = null;
            console.error("Unable to refresh active tab observation access", {
                error: error.message
            });
        }
    }
}

function getObservablePageUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(
            "This browser page cannot be observed. Open a regular HTTP or HTTPS website and try again."
        );
    }

    const hostname = url.hostname.toLowerCase();
    if (
        !["http:", "https:"].includes(url.protocol) ||
        (hostname === "chrome.google.com" && url.pathname.startsWith("/webstore")) ||
        hostname === "chromewebstore.google.com"
    ) {
        throw new Error(
            "Chrome settings, the Chrome Web Store, and other protected browser pages cannot be observed."
        );
    }

    return url;
}

function observeTab(tabId, expectedOrigin) {
    return chrome.runtime.sendMessage({
        type: "OBSERVE_ACTIVE_TAB",
        tabId,
        expectedOrigin
    });
}

askPageButton.addEventListener("click", async () => {
    const question = pageQuestionInput.value.trim();
    if (!question) {
        pageAnswerDisplay.textContent = "Enter a question about the webpage.";
        pageAnswerDisplay.hidden = false;
        return;
    }

    if (!currentObservation) {
        pageAnswerDisplay.textContent = "Observe a webpage before asking a question.";
        pageAnswerDisplay.hidden = false;
        return;
    }

    askPageButton.disabled = true;
    pageAnswerDisplay.textContent = "Getting an answer...";
    pageAnswerDisplay.hidden = false;

    try {
        const response = await fetch("http://127.0.0.1:8000/ask-page", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                question,
                page: buildPagePayload(currentObservation)
            })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || `Server returned status ${response.status}`);
        }

        pageAnswerDisplay.textContent = data.answer;
    } catch (error) {
        pageAnswerDisplay.textContent = `Unable to answer this question: ${error.message}`;
    } finally {
        askPageButton.disabled = false;
    }
});

    planClickButton.addEventListener("click", planClick);
    confirmClickButton.addEventListener("click", confirmClickPlan);
    cancelClickButton.addEventListener("click", () => {
        if (clickPlanningInProgress || clickConfirmationInProgress || !pendingClickConfirmation) {
            return;
        }

        pendingClickConfirmation = null;
        clickConfirmation.hidden = true;
        clickResultDisplay.textContent = "Click plan cancelled.";
        clickResultDisplay.hidden = false;
        updateClickControls();
    });

    async function planClick() {
        if (clickPlanningInProgress || clickConfirmationInProgress || pendingClickConfirmation) {
            return;
        }

        const instruction = clickInstructionInput.value.trim();
        if (!instruction) {
            clickResultDisplay.textContent = "Enter an instruction for the page action.";
            clickResultDisplay.hidden = false;
            return;
        }

        const observation = currentObservation;
        const tabContext = activeTabContext;
        if (clickObservationInvalidated) {
            clickResultDisplay.textContent = "The page changed. Observe it again before planning an action.";
            clickResultDisplay.hidden = false;
            return;
        }
        if (!observation) {
            clickResultDisplay.textContent = "Observe a webpage before planning a page action.";
            clickResultDisplay.hidden = false;
            return;
        }
        if (
            !tabContext ||
            !Number.isInteger(tabContext.tabId) ||
            tabContext.pageUrl?.href !== observation.url
        ) {
            clickResultDisplay.textContent = "The active page changed. Observe it again before planning an action.";
            clickResultDisplay.hidden = false;
            return;
        }

        const expiresAt = currentObservationAt + CLICK_APPROVAL_MAX_AGE_MS;
        if (!Number.isFinite(currentObservationAt) || Date.now() >= expiresAt) {
            clickResultDisplay.textContent = "This observation has expired. Observe the page again before planning an action.";
            clickResultDisplay.hidden = false;
            return;
        }

        const requestVersion = ++clickPlanRequestVersion;
        clickPlanningInProgress = true;
        clickPlanningTabId = tabContext.tabId;
        approvedClickApproval = null;
        clickResultDisplay.textContent = "Planning the page action...";
        clickResultDisplay.hidden = false;
        updateClickControls();

        try {
            const response = await fetch("http://127.0.0.1:8000/click-plan", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    instruction,
                    page: buildPagePayload(observation)
                })
            });
            const plan = await response.json();
            if (!response.ok) {
                throw new Error(plan.detail || `Server returned status ${response.status}`);
            }
            if (requestVersion !== clickPlanRequestVersion) {
                return;
            }
            if (
                currentObservation !== observation ||
                clickObservationInvalidated ||
                activeTabContext?.tabId !== tabContext.tabId ||
                activeTabContext.pageUrl?.href !== observation.url ||
                Date.now() >= expiresAt
            ) {
                throw new Error("The page or observation changed. Observe it again and retry.");
            }

            const validation = validateClickPlanResponse(plan, observation);
            if (!validation.target) {
                clickResultDisplay.textContent = validation.reason;
                return;
            }

            pendingClickConfirmation = {
                plan,
                target: validation.target,
                observation,
                tabId: tabContext.tabId,
                expectedUrl: observation.url,
                expiresAt
            };
            displayClickConfirmation(pendingClickConfirmation);
            clickResultDisplay.textContent = "Review the action details before confirming.";
        } catch (error) {
            if (requestVersion === clickPlanRequestVersion) {
                clickResultDisplay.textContent = `Unable to plan the page action: ${error.message}`;
            }
        } finally {
            if (requestVersion === clickPlanRequestVersion) {
                clickPlanningInProgress = false;
                clickPlanningTabId = null;
                updateClickControls();
            }
        }
    }

    function validateClickPlanResponse(plan, observation) {
        if (!plan || plan.valid !== true) {
            return {
                target: null,
                reason: typeof plan?.rejection_reason === "string" && plan.rejection_reason.trim()
                    ? plan.rejection_reason.slice(0, 300)
                    : "The backend did not approve this page action plan."
            };
        }

        if (typeof plan.target_id !== "string" || !CLICK_TARGET_ID_PATTERN.test(plan.target_id)) {
            return { target: null, reason: "The click plan contains an invalid target ID." };
        }

        const matches = observation.interactiveElements.filter(
            element => element.target_id === plan.target_id
        );
        if (matches.length !== 1) {
            return { target: null, reason: "The click plan target is not in the current page observation." };
        }

        const target = matches[0];
        const supportedTypes = new Set(["a", "link", "button", "tab", "input (button)"]);
        if (
            target.visible !== true ||
            target.disabled !== false ||
            target.submit_button ||
            !supportedTypes.has(target.type)
        ) {
            return { target: null, reason: "The selected element is not an eligible observed page target." };
        }

        const hasAnchorDestination = target.element_tag === "a" && Boolean(target.href);
        if (target.type === "a" || target.type === "link" || hasAnchorDestination) {
            try {
                const destination = new URL(target.href, observation.url);
                if (
                    !["http:", "https:"].includes(destination.protocol) ||
                    destination.username ||
                    destination.password
                ) {
                    return { target: null, reason: "The selected link has an unsupported destination." };
                }
            } catch {
                return { target: null, reason: "The selected link has no valid destination." };
            }
        }

        if (
            plan.element_type !== target.type ||
            plan.element_text !== target.label ||
            typeof plan.action_description !== "string" ||
            !plan.action_description.trim() ||
            plan.action_description.length > 300 ||
            typeof plan.expected_outcome !== "string" ||
            !plan.expected_outcome.trim() ||
            plan.expected_outcome.length > 300
        ) {
            return { target: null, reason: "The click plan details do not match the observed target." };
        }

        return { target, reason: null };
    }

    function displayClickConfirmation(pending) {
        let website = pending.expectedUrl;
        try {
            website = new URL(pending.expectedUrl).hostname || pending.expectedUrl;
        } catch {
            // Keep the observed URL as the display fallback.
        }

        clickConfirmationWebsite.textContent = website;
        clickConfirmationAction.textContent = pending.plan.action_description;
        clickConfirmationTarget.textContent = pending.target.label || "(no label)";
        clickConfirmationType.textContent = pending.target.type;
        clickConfirmationOutcome.textContent = pending.plan.expected_outcome;
        clickConfirmation.hidden = false;
        updateClickControls();
    }

    async function confirmClickPlan() {
        if (clickPlanningInProgress || clickConfirmationInProgress || !pendingClickConfirmation) {
            return;
        }

        const pending = pendingClickConfirmation;
        clickConfirmationInProgress = true;
        updateClickControls();
        let approvalConsumed = false;

        try {
            if (Date.now() >= pending.expiresAt) {
                throw new Error("This click plan has expired. Observe the page and create a new plan.");
            }
            if (
                pendingClickConfirmation !== pending ||
                clickObservationInvalidated ||
                currentObservation !== pending.observation ||
                currentObservation.url !== pending.expectedUrl ||
                activeTabContext?.tabId !== pending.tabId ||
                activeTabContext.pageUrl?.href !== pending.expectedUrl
            ) {
                throw new Error("The page or target changed. Observe the page and create a new plan.");
            }

            const validation = validateClickPlanResponse(pending.plan, pending.observation);
            if (validation.target !== pending.target) {
                throw new Error(validation.reason || "The click target is no longer valid.");
            }

            const [activeTab] = await chrome.tabs.query({
                active: true,
                lastFocusedWindow: true
            });
            if (
                pendingClickConfirmation !== pending ||
                Date.now() >= pending.expiresAt ||
                activeTab?.id !== pending.tabId ||
                activeTab.url !== pending.expectedUrl
            ) {
                throw new Error("The active page changed or the plan expired. Create a new plan.");
            }

            approvedClickApproval = {
                targetId: pending.plan.target_id,
                elementType: pending.target.type,
                elementText: pending.target.label,
                expectedHref: pending.target.href ?? null,
                actionDescription: pending.plan.action_description,
                expectedOutcome: pending.plan.expected_outcome,
                observation: pending.observation,
                tabId: pending.tabId,
                expectedUrl: pending.expectedUrl,
                approvedAt: Date.now(),
                expiresAt: pending.expiresAt,
                consumed: false
            };

            const approval = consumeClickApproval();
            if (!approval) {
                throw new Error("The click approval expired or became stale before execution.");
            }
            approvalConsumed = true;
            pendingClickConfirmation = null;
            clickConfirmation.hidden = true;
            clickResultDisplay.textContent = "Executing approved click...";
            clickResultDisplay.hidden = false;

            let execution;
            try {
                execution = await chrome.runtime.sendMessage({
                    type: "EXECUTE_APPROVED_CLICK",
                    tabId: approval.tabId,
                    expectedUrl: approval.expectedUrl,
                    targetId: approval.targetId,
                    expectedElementType: approval.elementType,
                    expectedElementText: approval.elementText,
                    expectedHref: approval.expectedHref,
                    approvalExpiresAt: approval.expiresAt
                });
            } catch (error) {
                clickResultDisplay.textContent =
                    `Click failed: the execution request did not complete. Do not retry automatically. ${error.message}`;
                return;
            }

            if (!execution?.ok) {
                const state = execution?.status === "rejected" ? "Click rejected" : "Click failed";
                clickResultDisplay.textContent = `${state}: ${execution?.error || "The click was not dispatched."}`;
                return;
            }
            if (execution.result?.status !== "dispatched") {
                clickResultDisplay.textContent =
                    "Click failed: the executor returned an invalid result. Do not retry automatically.";
                return;
            }

            clickResultDisplay.textContent = `Click dispatched: ${execution.result.message || "The page outcome was not verified."}`;
        } catch (error) {
            if (pendingClickConfirmation === pending) {
                pendingClickConfirmation = null;
                clickConfirmation.hidden = true;
            }
            clickResultDisplay.textContent = approvalConsumed
                ? `Click failed: ${error.message}`
                : `Unable to approve the page action: ${error.message}`;
            clickResultDisplay.hidden = false;
        } finally {
            clickConfirmationInProgress = false;
            updateClickControls();
        }
    }

    function consumeClickApproval() {
        const approval = approvedClickApproval;
        if (
            !approval ||
            approval.consumed ||
            Date.now() >= approval.expiresAt ||
            clickObservationInvalidated ||
            currentObservation !== approval.observation ||
            activeTabContext?.tabId !== approval.tabId ||
            activeTabContext.pageUrl?.href !== approval.expectedUrl
        ) {
            approvedClickApproval = null;
            return null;
        }

        approvedClickApproval = null;
        return { ...approval, consumed: true };
    }

    function hasClickStateForTab(tabId) {
        return pendingClickConfirmation?.tabId === tabId ||
            approvedClickApproval?.tabId === tabId ||
            (clickPlanningInProgress && clickPlanningTabId === tabId);
    }

    function invalidateClickState(reason) {
        const hadClickState = Boolean(
            pendingClickConfirmation || approvedClickApproval || clickPlanningInProgress
        );
        clickPlanRequestVersion += 1;
        pendingClickConfirmation = null;
        approvedClickApproval = null;
        clickPlanningInProgress = false;
        clickPlanningTabId = null;
        clickConfirmation.hidden = true;
        if (hadClickState) {
            clickResultDisplay.textContent = `Click approval invalidated: ${reason}`;
            clickResultDisplay.hidden = false;
        }
        updateClickControls();
    }

    function updateClickControls() {
        planClickButton.disabled = clickPlanningInProgress ||
            clickConfirmationInProgress ||
            Boolean(pendingClickConfirmation);
        confirmClickButton.disabled = clickConfirmationInProgress || !pendingClickConfirmation;
        cancelClickButton.disabled = clickConfirmationInProgress || !pendingClickConfirmation;
    }

searchPageButton.addEventListener("click", async () => {
    if (searchOperationInProgress || pendingSearchConfirmation) {
        return;
    }

    const query = searchQueryInput.value.trim();
    if (!query) {
        searchResultDisplay.textContent = "Enter what you want to search for.";
        searchResultDisplay.hidden = false;
        return;
    }

    if (!currentObservation) {
        searchResultDisplay.textContent = "Observe a webpage before searching it.";
        searchResultDisplay.hidden = false;
        return;
    }

    searchPageButton.disabled = true;
    searchOperationInProgress = true;
    searchResultDisplay.textContent = "Finding a search field...";
    searchResultDisplay.hidden = false;
    const beforeObservation = currentObservation;

    try {
        const planResponse = await fetch("http://127.0.0.1:8000/search-plan", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                query,
                page: buildPagePayload(beforeObservation)
            })
        });
        const planData = await planResponse.json();
        if (!planResponse.ok) {
            throw new Error(planData.detail || `Server returned status ${planResponse.status}`);
        }

        if (planData.action !== "search") {
            searchResultDisplay.textContent = planData.message || "No suitable search field was found.";
            return;
        }

        if (
            planData.query !== query ||
            typeof planData.input_target_id !== "string"
        ) {
            throw new Error("The AI returned an invalid search target.");
        }

        const searchInput = beforeObservation.interactiveElements.find(
            element => element.target_id === planData.input_target_id
        );
        if (!isValidSearchInput(searchInput)) {
            throw new Error("The selected search field is not in the current page observation.");
        }

        let submitButton = null;
        if (planData.submit_target_id !== null) {
            if (typeof planData.submit_target_id !== "string") {
                throw new Error("The AI returned an invalid search button.");
            }

            submitButton = beforeObservation.interactiveElements.find(
                element => element.target_id === planData.submit_target_id
            );
            if (
                !submitButton?.submit_button ||
                submitButton.form_index !== searchInput.form_index
            ) {
                throw new Error("The selected search button does not belong to the search form.");
            }
        }

        const fieldDescription = searchInput.label ||
            searchInput.placeholder ||
            searchInput.name ||
            "search field";
        const submitDescription = submitButton
            ? `the "${submitButton.label || "submit"}" button`
            : "the form's default submit action";
        pendingSearchConfirmation = {
            query,
            expectedUrl: beforeObservation.url,
            observation: beforeObservation,
            input: searchInput,
            submitButton,
            inputTargetId: searchInput.target_id,
            submitTargetId: submitButton?.target_id ?? null,
            tabId: activeTabContext?.tabId
        };
        searchConfirmationWebsite.textContent = new URL(beforeObservation.url).hostname;
        searchConfirmationQuery.textContent = query;
        searchConfirmationInput.textContent = fieldDescription;
        searchConfirmationSubmit.textContent = submitDescription;
        searchConfirmation.hidden = false;
        searchResultDisplay.textContent = "Review the search details and confirm to continue.";
    } catch (error) {
        searchResultDisplay.textContent = `Search automation failed: ${error.message}`;
    } finally {
        searchOperationInProgress = false;
        updateSearchControls();
    }
});

confirmSearchButton.addEventListener("click", confirmPendingSearch);
cancelSearchButton.addEventListener("click", () => {
    if (searchOperationInProgress || !pendingSearchConfirmation) {
        return;
    }

    pendingSearchConfirmation = null;
    searchConfirmation.hidden = true;
    searchResultDisplay.textContent = "Search cancelled.";
    updateSearchControls();
});

async function confirmPendingSearch() {
    if (searchOperationInProgress || !pendingSearchConfirmation) {
        return;
    }

    const pending = pendingSearchConfirmation;
    pendingSearchConfirmation = null;
    searchConfirmation.hidden = true;
    searchOperationInProgress = true;
    updateSearchControls();

    let executionResult = null;
    try {
        if (
            currentObservation !== pending.observation ||
            currentObservation.url !== pending.expectedUrl ||
            activeTabContext?.tabId !== pending.tabId ||
            activeTabContext?.pageUrl.href !== pending.expectedUrl
        ) {
            throw new Error("The page or search target changed. Observe the page again and retry.");
        }

        searchResultDisplay.textContent = "Submitting search...";
        const execution = await chrome.runtime.sendMessage({
            type: "EXECUTE_SEARCH",
            query: pending.query,
            expectedUrl: pending.expectedUrl,
            inputTargetId: pending.inputTargetId,
            submitTargetId: pending.submitTargetId
        });
        if (!execution?.ok || typeof execution.result?.message !== "string") {
            throw new Error(execution?.error || "The search was not submitted.");
        }
        executionResult = execution.result;

        searchResultDisplay.textContent = "Search submitted. Checking the results...";
        await delay(1200);
        const afterObservation = await observeAfterSearch();
        displayObservation(afterObservation);

        const verificationResponse = await fetch("http://127.0.0.1:8000/verify-search", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                query: pending.query,
                before_page: buildPagePayload(pending.observation),
                after_page: buildPagePayload(afterObservation, { includeSearchEvidence: true })
            })
        });
        const verificationData = await verificationResponse.json();
        if (!verificationResponse.ok) {
            throw new Error(
                verificationData.detail || `Server returned status ${verificationResponse.status}`
            );
        }

        if (!["results_found", "no_results", "uncertain"].includes(verificationData.status)) {
            throw new Error("The search verifier returned an invalid status.");
        }

        const resultLabels = {
            results_found: "Results found",
            no_results: "No results found",
            uncertain: "Results could not be verified"
        };
        searchResultDisplay.textContent =
            `${executionResult.message} ${resultLabels[verificationData.status]}: ${verificationData.message}`;
    } catch (error) {
        searchResultDisplay.textContent = executionResult
            ? `${executionResult.message} Results could not be verified: ${error.message}`
            : `Search automation failed: ${error.message}`;
    } finally {
        searchOperationInProgress = false;
        updateSearchControls();
    }
}

function discardPendingSearchConfirmation(reason) {
    if (!pendingSearchConfirmation) {
        return;
    }

    pendingSearchConfirmation = null;
    searchConfirmation.hidden = true;
    searchResultDisplay.textContent =
        `Search confirmation discarded: ${reason} Observe the page again before searching.`;
    updateSearchControls();
}

function updateSearchControls() {
    searchPageButton.disabled = searchOperationInProgress || Boolean(pendingSearchConfirmation);
    confirmSearchButton.disabled = searchOperationInProgress || !pendingSearchConfirmation;
    cancelSearchButton.disabled = searchOperationInProgress || !pendingSearchConfirmation;
}

function displayObservation(observation) {
    if (pendingSearchConfirmation && pendingSearchConfirmation.observation !== observation) {
        discardPendingSearchConfirmation("A new page observation replaced the search target.");
    }
    if (currentObservation !== observation) {
        invalidateClickState("A new page observation replaced the target.");
    }
    currentObservation = observation;
    currentObservationAt = Date.now();
    clickObservationInvalidated = false;
    pageTitleDisplay.textContent = observation.title || "Untitled page";
    pageUrlDisplay.textContent = observation.url;
    pageTextDisplay.textContent = observation.visibleText || "No visible text found.";
    if (observation.visibleTextTruncated) {
        pageTextDisplay.textContent += "\n\n[Visible text truncated after 12,000 characters.]";
    }
    interactiveElementsDisplay.replaceChildren();

    for (const element of observation.interactiveElements) {
        const item = document.createElement("li");
        const description = `${element.type}: ${element.label || "(no label)"}`;
        item.textContent = element.href
            ? `${description} - ${element.href}`
            : description;

        if (element.placeholder) {
            item.textContent += ` (placeholder: ${element.placeholder})`;
        }

        interactiveElementsDisplay.append(item);
    }

    if (observation.interactiveElementsTruncated) {
        const item = document.createElement("li");
        item.textContent = "Additional interactive elements were omitted.";
        interactiveElementsDisplay.append(item);
    }

    observationDisplay.hidden = false;
}

function isValidSearchInput(element) {
    return Boolean(
        element &&
        typeof element.target_id === "string" &&
        element.searchable &&
        element.form_index !== null &&
        (element.type.startsWith("input (") || element.type === "searchbox")
    );
}

function buildPagePayload(observation, { includeSearchEvidence = false } = {}) {
    const page = {
        title: observation.title.slice(0, 300),
        url: observation.url.slice(0, 2048),
        visible_text: observation.visibleText.slice(0, 12000),
        interactive_elements: observation.interactiveElements
            .slice(0, 100)
            .map(element => ({
                type: element.type.slice(0, 40),
                label: element.label.slice(0, 200),
                index: element.index,
                target_id: element.target_id ?? null,
                element_tag: element.element_tag?.slice(0, 40) ?? null,
                accessible_role: element.accessible_role?.slice(0, 40) ?? null,
                accessible_name: element.accessible_name?.slice(0, 200) ?? null,
                landmark_label: element.landmark_label?.slice(0, 200) ?? null,
                ancestor_context: Array.isArray(element.ancestor_context)
                    ? element.ancestor_context.slice(0, 4).map(context => context.slice(0, 180))
                    : [],
                visible: typeof element.visible === "boolean" ? element.visible : null,
                disabled: typeof element.disabled === "boolean" ? element.disabled : null,
                search_candidate: Boolean(element.search_candidate),
                searchable: Boolean(element.searchable),
                search_rejection_reason: element.search_rejection_reason?.slice(0, 200) ?? null,
                input_type: element.input_type?.slice(0, 40) ?? null,
                name: element.name?.slice(0, 200) ?? null,
                element_id: element.element_id?.slice(0, 200) ?? null,
                form_index: element.form_index ?? null,
                submit_button: Boolean(element.submit_button),
                ...(element.placeholder
                    ? { placeholder: element.placeholder.slice(0, 200) }
                    : {}),
                ...(element.href
                    ? { href: element.href.slice(0, 2048) }
                    : {})
            }))
    };

    if (includeSearchEvidence) {
        page.search_input_values = observation.interactiveElements
            .filter(element => element.search_candidate && typeof element.search_value === "string")
            .slice(0, 20)
            .map(element => element.search_value.slice(0, 300));
        page.search_result_container_count = Number.isInteger(observation.searchResultContainerCount)
            ? Math.min(Math.max(observation.searchResultContainerCount, 0), 500)
            : 0;
        page.search_result_links = (observation.searchResultLinks || [])
            .slice(0, 50)
            .map(link => ({
                text: typeof link.text === "string" ? link.text.slice(0, 200) : "",
                href: typeof link.href === "string" ? link.href.slice(0, 2048) : ""
            }));
    }

    return page;
}

async function observeAfterSearch() {
    let lastError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
            const response = await chrome.runtime.sendMessage({
                type: "OBSERVE_ACTIVE_TAB"
            });
            if (!response?.ok || !response.observation) {
                throw new Error(response?.error || "The results page did not return an observation.");
            }
            return response.observation;
        } catch (error) {
            lastError = error;
            if (attempt < 5) {
                await delay(700);
            }
        }
    }

    throw new Error(`Could not observe the page after searching: ${lastError.message}`);
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
