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

function displayObservation(observation) {
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
