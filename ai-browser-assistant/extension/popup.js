const instructionInput = document.getElementById("instruction");
const runTaskButton = document.getElementById("runTask");
const resultDisplay = document.getElementById("result");

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