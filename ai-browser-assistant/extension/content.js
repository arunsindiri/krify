if (!globalThis.aiBrowserObserverInstalled) {
    globalThis.aiBrowserObserverInstalled = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== "OBSERVE_PAGE") {
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
                interactiveElements: interactiveElements.elements,
                interactiveElementsTruncated: interactiveElements.truncated
            }
        });

        return false;
    });
}

function collectInteractiveElements() {
    const candidates = document.querySelectorAll(
        'button, a[href], input, textarea, select, [role="button"], [role="link"]'
    );
    const visibleElements = [];
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
        const type = tagName === "input"
            ? `input (${element.type || "text"})`
            : element.getAttribute("role") || tagName;
        const label = (
            element.getAttribute("aria-label") ||
            element.innerText ||
            element.textContent ||
            element.getAttribute("title") ||
            ""
        ).trim().replace(/\s+/g, " ").slice(0, 200);
        const descriptor = { type, label };
        const placeholder = element.getAttribute("placeholder");

        if (placeholder) {
            descriptor.placeholder = placeholder.slice(0, 200);
        }

        if (tagName === "a") {
            descriptor.href = element.href;
        }

        visibleElements.push(descriptor);
        if (visibleElements.length > 100) {
            visibleElements.pop();
            truncated = true;
            break;
        }
    }

    return {
        elements: visibleElements,
        truncated
    };
}
