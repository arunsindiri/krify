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
const searchQueryInput = document.getElementById("searchQuery");
const searchPageButton = document.getElementById("searchPage");
const searchResultDisplay = document.getElementById("searchResult");
let currentObservation = null;

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
            resultDisplay.textContent = data.message;

            chrome.tabs.create({
                url: data.url
            });
        } else {
            resultDisplay.textContent = data.message;
        }

    } catch (error) {
        resultDisplay.textContent =
            `Failed to contact backend: ${error.message}`;
    }
});

observePageButton.addEventListener("click", async () => {
    observePageButton.disabled = true;
    observationStatus.textContent = "Reading the active webpage...";

    try {
        const response = await chrome.runtime.sendMessage({
            type: "OBSERVE_ACTIVE_TAB"
        });

        if (!response?.ok) {
            throw new Error(response?.error || "Unable to observe the active webpage.");
        }

        displayObservation(response.observation);
        observationStatus.textContent = "Page observation complete.";
    } catch (error) {
        observationStatus.textContent = `Unable to observe this page: ${error.message}`;
    } finally {
        observePageButton.disabled = false;
    }
});

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

searchPageButton.addEventListener("click", async () => {
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
    searchResultDisplay.textContent = "Finding a search field...";
    searchResultDisplay.hidden = false;
    const beforeObservation = currentObservation;
    let executionResult = null;

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

        if (planData.query !== query || !Number.isInteger(planData.input_index)) {
            throw new Error("The AI returned an invalid search target.");
        }

        const searchInput = beforeObservation.interactiveElements.find(
            element => element.index === planData.input_index
        );
        if (!isValidSearchInput(searchInput)) {
            throw new Error("The selected search field is not in the current page observation.");
        }

        let submitButton = null;
        if (planData.submit_index !== null) {
            if (!Number.isInteger(planData.submit_index)) {
                throw new Error("The AI returned an invalid search button.");
            }

            submitButton = beforeObservation.interactiveElements.find(
                element => element.index === planData.submit_index
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
        if (!window.confirm(
            `Submit "${query}" using ${fieldDescription} and ${submitDescription} on this page?`
        )) {
            searchResultDisplay.textContent = "Search cancelled.";
            return;
        }

        searchResultDisplay.textContent = "Submitting search...";
        const execution = await chrome.runtime.sendMessage({
            type: "EXECUTE_SEARCH",
            query,
            expectedUrl: beforeObservation.url,
            inputIndex: searchInput.index,
            submitIndex: submitButton?.index ?? null,
            expectedInput: searchInput,
            expectedSubmit: submitButton
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
                query,
                before_page: buildPagePayload(beforeObservation),
                after_page: buildPagePayload(afterObservation)
            })
        });
        const verificationData = await verificationResponse.json();
        if (!verificationResponse.ok) {
            throw new Error(
                verificationData.detail || `Server returned status ${verificationResponse.status}`
            );
        }

        if (!["results_found", "no_results", "uncertain"].includes(verificationData.status)) {
            throw new Error("The AI returned an invalid search verification.");
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
        searchPageButton.disabled = false;
    }
});

function displayObservation(observation) {
    currentObservation = observation;
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
        element.searchable &&
        element.form_index !== null &&
        (element.type.startsWith("input (") || element.type === "searchbox")
    );
}

function buildPagePayload(observation) {
    return {
        title: observation.title.slice(0, 300),
        url: observation.url.slice(0, 2048),
        visible_text: observation.visibleText.slice(0, 12000),
        interactive_elements: observation.interactiveElements
            .slice(0, 100)
            .map(element => ({
                type: element.type.slice(0, 40),
                label: element.label.slice(0, 200),
                index: element.index,
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
