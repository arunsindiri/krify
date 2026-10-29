# AI Browser Assistant

## Project Overview

AI Browser Assistant is a Chrome extension connected to a Python backend. A user enters an instruction in the extension, the backend asks a Groq AI model to interpret it, and the extension performs a supported browser action based on the response.

The current working end-to-end example is opening a website from a natural-language instruction, such as:
- `Open YouTube`
- `Open GitHub`
- `Take me to Google`

> **Current scope:** The project can interpret instructions to open websites. Searching websites, reading page content, clicking page elements, and more advanced automation have not been implemented yet.

## Current Architecture

```text
User enters an instruction
          |
          v
Chrome Extension Popup (HTML + JavaScript)
          |
          | POST /task with JSON
          v
Python Backend (FastAPI)
          |
          | Sends instruction to Groq
          v
Groq AI Model
          |
          | Returns JSON action
          v
FastAPI returns the action to the extension
          |
          v
Extension opens the returned URL in a new Chrome tab
```

## Technology Stack

- **Browser extension:** Chrome Extension, Manifest V3
- **Popup UI:** HTML and JavaScript
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
│   └── test_groq.py        # Standalone test of Groq API connectivity
├── extension/
│   ├── manifest.json       # Chrome extension configuration
│   ├── popup.html          # Popup interface
│   └── popup.js            # Sends instructions and opens returned URLs
├── .gitignore              # Excludes local secrets and environment files
└── README.md               # Project documentation
```

The exact structure may include generated folders such as `__pycache__/`. These are not required in Git.

## How the Current Flow Works

1. The user types an instruction into the extension popup.
2. `popup.js` sends a `POST` request to `http://127.0.0.1:8000/task`.
3. FastAPI receives the instruction using the `TaskRequest` Pydantic model.
4. The backend sends the instruction to Groq with a system prompt describing the supported action and required JSON response.
5. Groq returns an action, URL, and message.
6. The backend parses the AI response as JSON and returns it to the extension.
7. If the response action is `open_website`, the extension uses `chrome.tabs.create()` to open the returned URL in a new tab.
8. If the action is not supported, the extension displays the message returned by the backend.

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
5. Open the extension popup and enter a task such as `Open YouTube`.

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
- Created a Chrome Manifest V3 extension with a popup UI.
- Connected the extension popup to the Python backend using `fetch()`.
- Verified that the backend receives and returns the user's instruction.
- Created a separate Groq connectivity test in `test_groq.py`.
- Resolved the model-not-found error by switching to `openai/gpt-oss-120b`.
- Integrated Groq into `main.py` so the AI interprets the instruction and returns a JSON action.
- Updated the extension to open the URL returned by the backend.
- Tested natural-language instructions to open YouTube, GitHub, and Google successfully.

## Known Limitations and Next Steps

The project is an early working prototype. The current capabilities are limited to opening websites.

Potential next steps:
1. Add stronger validation for AI-generated actions and URLs before opening them.
2. Improve error messages for AI/API/network failures.
3. Add a `requirements.txt` file for reproducible installation.
4. Add a small set of supported browser actions beyond opening websites.
5. Implement page observation so the assistant can understand the active webpage.
6. Add execution results and validation so the backend can check whether an action succeeded.
7. Expand toward a plan-execute-observe-validate loop for multi-step tasks.

The next feature should be chosen and implemented incrementally, testing the complete workflow after each change.

## Important Security Notes

- Keep the Groq API key in `backend/.env`; never place it in extension JavaScript.
- Do not commit `.env` or `.venv`.
- Treat model output as untrusted input. Validate permitted actions and destination URLs before executing them.
- Only add browser permissions when a feature actually requires them.
- Before implementing actions that click, submit forms, or modify website data, add suitable safeguards and confirmation for sensitive actions.
