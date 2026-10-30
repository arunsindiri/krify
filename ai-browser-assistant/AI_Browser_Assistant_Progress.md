# AI Browser Assistant

## Project Overview

AI Browser Assistant is a Chrome extension connected to a Python backend. A user enters an instruction in the extension, the backend asks a Groq AI model to interpret it, and the extension performs a supported browser action based on the response.

The current working end-to-end example is opening a website from a natural-language instruction, such as:
- `Open YouTube`
- `Open GitHub`
- `Take me to Google`

> **Current scope:** The project can open websites, observe the active page, answer questions about it, and perform a user-confirmed search through a detected search form. Other page interactions and multi-step automation are not implemented.

## Current Architecture

```text
User enters an instruction or observes a page
          |
          v
Chrome Extension Side Panel
          |
          | POST /task, /ask-page, or search endpoints
          v
Python Backend (FastAPI)
          |
          | Sends instructions or bounded page context to Groq
          v
Groq AI Model
          |
          | Returns website action, page answer, or validated search plan
          v
FastAPI returns the result to the extension
          |
          +--> Extension opens a returned URL
          |
          +--> Side Panel displays answers and search results
          |
          +--> Content script safely submits a confirmed search form
```

## Technology Stack

- **Browser extension:** Chrome Extension, Manifest V3
- **Side Panel UI:** HTML, CSS, and JavaScript
- **Backend:** Python and FastAPI
- **ASGI server:** Uvicorn
- **AI provider:** Groq API
- **AI model:** `openai/gpt-oss-120b` (configured in the current backend code)
- **Python packages:** `fastapi`, `uvicorn`, `groq`, `python-dotenv`
- **Configuration:** `.env` file for the Groq API key

## Project Structure

```text
ai-browser-assistant/
├── backend/
│   ├── .venv/              # Local Python virtual environment (do not commit)
│   ├── .env                # Groq API key (do not commit)
│   ├── main.py             # FastAPI endpoints and Groq integration
│   ├── test_groq.py        # Standalone test of Groq API connectivity
│   └── test_search_automation.py  # Search planning validation tests
├── extension/
│   ├── manifest.json       # Chrome extension and Side Panel configuration
│   ├── background.js       # Opens the Side Panel and relays page-observation requests
│   ├── content.js          # Reads visible page text and interactive element labels
│   ├── sidepanel.html      # Full-height Side Panel interface
│   └── sidepanel.js        # Displays observations and handles assistant instructions
├── .gitignore              # Excludes local secrets and environment files
└── README.md               # Project documentation
```

The exact structure may include generated folders such as `__pycache__/`. These are not required in Git.

## How the Current Flow Works

1. The user opens the extension Side Panel from the toolbar and types an instruction.
2. `sidepanel.js` sends a `POST` request to `http://127.0.0.1:8000/task`.
3. FastAPI receives the instruction using the `TaskRequest` Pydantic model.
4. The backend sends the instruction to Groq with a system prompt describing the supported action and required JSON response.
5. Groq returns an action, URL, and message.
6. The backend parses the AI response as JSON and returns it to the extension.
7. If the response action is `open_website`, the extension uses `chrome.tabs.create()` to open the returned URL in a new tab.
8. If the action is not supported, the extension displays the message returned by the backend.

To observe a page, the Side Panel keeps its active tab URL and access state synchronized before the user clicks Observe. If the site origin is not already granted and there is no toolbar-click `activeTab` grant for that tab, the click handler immediately calls `chrome.permissions.request()` for only that origin, before any asynchronous tab lookup or injection. It verifies the returned grant with `chrome.permissions.contains()`, then asks the service worker to inject `content.js` into the same tab and origin. A short-lived `storage.session` record preserves toolbar-click fallback state across service-worker restarts and is cleared on navigation or tab close. The manifest declares optional HTTP(S) host patterns, but does not grant access to all sites. Chrome settings, the Chrome Web Store, and other non-web pages are rejected before a permission request.

To ask a question about the page, the user first observes it and enters a question in the Side Panel. The panel sends the observation and question to `POST /ask-page`; the backend limits the page context to 16,000 characters, sends it to Groq, and returns the answer. The Groq API key remains on the backend.

For search automation, the Side Panel sends the query and observed page to `POST /search-plan`. The backend builds form-scoped candidates and sends Groq only observed eligible search inputs with submit buttons from that same form. This avoids confusing the search submit button with unrelated page controls. The backend validates returned indices; invalid selections return a clear `cannot_search` response rather than an unexplained server error. The Side Panel checks the plan and asks the user to confirm it. The service worker forwards the structured action to `content.js`, which rechecks the target and submits only a same-origin GET search form. The panel observes the page again and calls `POST /verify-search`. Verification checks that the requested query matches the search URL or current search input, then requires result containers/links or an explicit no-results message. A URL change by itself is reported as uncertain. AI output is never executed as code.

## Current API

### `GET /`

Health-check endpoint.

Example response:

```json
{
  "message": "AI Browser Assistant Backend is running!"
}
```

### `POST /task`

Accepts a natural-language instruction.

Example request:

```json
{
  "instruction": "Please open YouTube for me"
}
```

Example response (wording can vary):

```json
{
  "action": "open_website",
  "url": "https://www.youtube.com",
  "message": "Opening YouTube"
}
```

For a request outside the currently supported scope, the AI is instructed to return an `unknown` action with a message that the task cannot yet be performed.

### `POST /ask-page`

Accepts a question and a bounded webpage observation.

Example request:

```json
{
  "question": "What is this page about?",
  "page": {
    "title": "Example page",
    "url": "https://example.com/",
    "visible_text": "Visible page text",
    "interactive_elements": [
      {
        "type": "button",
        "label": "Learn more"
      }
    ]
  }
}
```

The backend validates the request fields and bounds the page information sent to Groq. The endpoint returns `{"answer": "..."}`.

### `POST /search-plan`

Accepts a search query and page observation. Returns a structured `search` plan with an observed input index and an optional submit-button index, or `cannot_search` if no supported field is found. Groq receives only eligible search fields paired with submit buttons in their own form. The backend rejects any plan index that does not match that candidate set and explains that no action was submitted.

### `POST /verify-search`

Accepts the query and before/after observations. The post-search observation may include bounded `search_input_values`, `search_result_container_count`, and `search_result_links` evidence collected from visible page controls and generic result-like containers. Returns `results_found` only when the query matches and result evidence exists, `no_results` when a matching query has an explicit no-results message, and otherwise `uncertain`. A matching URL alone is not enough to claim success.

## Setup and Run

### Requirements

- Python installed
- Google Chrome
- VS Code or another code editor
- A Groq account and API key

### 1. Open the project

Open the project folder in VS Code:

```text
C:\krify\ai-browser-assistant
```

### 2. Activate the Python environment

In PowerShell:

```powershell
cd C:\krify\ai-browser-assistant\backend
.\.venv\Scripts\Activate.ps1
```

### 3. Install dependencies

If the packages are not installed in the virtual environment, run:

```powershell
python -m pip install fastapi uvicorn groq python-dotenv
```

To make future setup easier, a `requirements.txt` file should be added with the project's dependencies.

### 4. Configure the Groq API key

Create `backend/.env`:

```dotenv
GROQ_API_KEY=your_actual_groq_api_key
```

Replace the example value with your real key. **Never commit `.env` or publish the API key.**

### 5. Start the backend

From the `backend` folder, with the virtual environment activated:

```powershell
python -m uvicorn main:app --reload
```

The backend runs at:

```text
http://127.0.0.1:8000
```

API documentation is available at:

```text
http://127.0.0.1:8000/docs
```

### 6. Load the Chrome extension

1. Open `chrome://extensions/` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the project's `extension` folder:
   `C:\krify\ai-browser-assistant\extension`
5. Click the extension's toolbar icon to open the Side Panel, then enter a task such as `Open YouTube`.

If you make changes to the extension files, return to `chrome://extensions/` and click the extension's reload icon.

## Git and Secret Safety

Before pushing the project, check that the root `.gitignore` includes:

```gitignore
backend/.env
backend/.venv/
backend/__pycache__/
```

Do not commit API keys, access tokens, or other secrets. The `.env` file should remain on your computer and be recreated by each developer using their own key.

If a real API key has ever been committed or shared publicly, revoke it and generate a replacement.

## Work Completed So Far

- Created the project folder and separated backend and extension code.
- Created a Python virtual environment.
- Installed FastAPI, Uvicorn, Groq, and python-dotenv.
- Built a FastAPI health-check endpoint.
- Created a `POST /task` endpoint to receive instructions.
- Tested the backend endpoint using FastAPI's `/docs` interface.
- Created a Chrome Manifest V3 extension with a Side Panel UI that remains available while browsing.
- Configured the toolbar icon to open the Side Panel.
- Connected the extension Side Panel to the Python backend using `fetch()`.
- Added user-triggered webpage observation for the active tab, including visible text and visible buttons, links, and input controls.
- Added the least-privilege `activeTab` and `scripting` permissions for on-demand observation.
- Added runtime optional host access scoped to the active site's origin, requested directly in the Observe button's click handler and verified before injection.
- Added the `POST /ask-page` endpoint and Side Panel question UI for Groq-powered answers grounded in observed page information.
- Limited webpage context sent to Groq to 16,000 characters and kept the API key exclusively in the backend.
- Added AI-planned, user-confirmed search automation restricted to observed search fields and same-origin GET forms, followed by fresh observation and signal-based result verification.
- Added tests for matching results, explicit no-results, mismatched queries, and URL-only/uncertain observations.
- Verified that the backend receives and returns the user's instruction.
- Created a separate Groq connectivity test in `test_groq.py`.
- Resolved the model-not-found error by switching to `openai/gpt-oss-120b`.
- Integrated Groq into `main.py` so the AI interprets the instruction and returns a JSON action.
- Updated the extension to open the URL returned by the backend.
- Tested natural-language instructions to open YouTube, GitHub, and Google successfully.

## Known Limitations and Next Steps

The project is an early working prototype. Search automation only supports visible, form-associated search inputs and same-origin GET forms. It does not click arbitrary page elements or execute AI-generated code.

Potential next steps:
1. Add stronger validation for AI-generated actions and URLs before opening them.
2. Improve error messages for AI/API/network failures.
3. Add a `requirements.txt` file for reproducible installation.
4. Expand cross-site result-evidence coverage, including pages that load results asynchronously.
5. Add execution results and validation for the supported browser actions.
6. Expand toward a plan-execute-observe-validate loop for multi-step tasks.

The next feature should be chosen and implemented incrementally, testing the complete workflow after each change.

Run the focused search-planning tests from `backend` with:

```powershell
.\.venv\Scripts\python.exe -B -m unittest test_search_automation -v
```

## Important Security Notes

- Keep the Groq API key in `backend/.env`; never place it in extension JavaScript.
- Do not commit `.env` or `.venv`.
- Treat model output as untrusted input. Validate permitted actions and destination URLs before executing them.
- Only add browser permissions when a feature actually requires them.
- Before implementing actions that click, submit forms, or modify website data, add suitable safeguards and confirmation for sensitive actions.
