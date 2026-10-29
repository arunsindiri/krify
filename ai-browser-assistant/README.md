# AI-Powered Browser Automation Extension

An AI-powered Chrome extension that accepts a user's instruction, creates a step-by-step plan, performs browser actions, and checks whether the task was completed successfully.

> **Development approach:** Build from scratch in small, testable steps. Do not implement every component at once. Agree on the next step before beginning it.

## 1. Project Goal

A user gives an instruction in the extension, for example:

- “Open YouTube and search for Python tutorials.”
- “Find the search box on this page and search for Python developer jobs.”
- “Fill in the name and email fields in this form.”

The application should understand the request, plan the actions, execute browser interactions, validate the results, and recover or ask for help when something fails.

The extension must not silently perform sensitive or irreversible actions. Actions such as submitting forms, sending messages, deleting information, or making purchases should require appropriate user confirmation.

## 2. Recommended Technology Stack

### Browser extension
- **Chrome Extension Manifest V3** — extension configuration and permissions.
- **JavaScript** — browser integration and extension logic.
- **React** — extension user interface.
- **Vite** — frontend development and bundling.
- **CSS** — styling.
- **Chrome Extensions APIs** — side panel, tabs, messaging, and other permitted browser capabilities.
- **Content scripts and DOM APIs** — inspect and interact with webpage elements when permitted.

### Backend
- **Python** — backend and AI workflow logic.
- **FastAPI** — HTTP API between the extension and backend.
- **Pydantic** — validate API requests, plans, and execution results.
- **REST + JSON** — communication format between the extension and backend.

### AI
- **Groq API initially**, if a suitable model and usable free-tier limits are available.
- **OpenRouter as an optional alternative** for access to different models.
- Keep provider-specific code behind a small interface so the provider can be changed later.
- AI provider availability, models, rate limits, and pricing must be checked at implementation time.
- API keys must stay on the backend and must never be embedded in extension code.

### Database, when needed
- **PostgreSQL** — persistent storage for users, tasks, and task history.
- **SQLAlchemy 2.x** — Python database toolkit/ORM.
- **Alembic** — database schema migrations.

### Authentication, when needed
- **JWT** — authenticate requests if user accounts are introduced.
- **Argon2 password hashing** — only if password-based login is implemented.
- Authentication is not required for the first local prototype unless a later requirement calls for it.

### Development and testing
- **VS Code** — editor.
- **Git and GitHub** — version control and repository hosting.
- **Postman** — manually test backend endpoints.
- **Pytest** — test Python backend logic.
- Browser developer tools and extension inspection tools — debug extension behavior.

## 3. High-Level Architecture

```text
                         USER
                           |
                           v
                 +-------------------+
                 | Chrome Extension  |
                 | React UI / Side   |
                 | Panel             |
                 +-------------------+
                           |
                     User instruction
                           |
                           v
                 +-------------------+
                 | Python / FastAPI  |
                 | Backend           |
                 +-------------------+
                           |
                           v
                 +-------------------+
                 |     ANALYSER      |
                 | Understand task   |
                 | Define goal and   |
                 | expected outcome  |
                 +-------------------+
                           |
                           v
                 +-------------------+
                 |      PLANNER      |
                 | Create ordered    |
                 | steps and expected|
                 | result per step   |
                 +-------------------+
                           |
                 Plan / next action
                           |
                           v
                 +-------------------+
                 | JavaScript Chrome |
                 | Extension         |
                 +-------------------+
                           |
                           v
                 +-------------------+
                 |     EXECUTOR      |
                 | Navigate, inspect,|
                 | click, type, etc. |
                 +-------------------+
                           |
                           v
                 +-------------------+
                 |     VALIDATOR     |
                 | Compare expected  |
                 | result with actual|
                 | browser outcome   |
                 +-------------------+
                           |
                    +------+------+
                    |             |
                 Success        Failure
                    |             |
              Continue/finish     v
                            Send result and
                            failure details
                            to backend
                                  |
                                  v
                               PLANNER
                         revise the plan
```

This is a logical architecture, not a requirement to create a separate service or file for every box. Components can begin as small modules within one Python backend and one extension.

## 4. Component Responsibilities

### Extension UI
- Accept the user's instruction.
- Show the task plan, current step, progress, and final result.
- Show errors and request confirmation when required.
- Let the user stop a running task.

### Analyser (backend)
- Interpret the user's instruction and relevant page context.
- Define the task goal and overall expected outcome.
- Ask for clarification when the instruction is ambiguous.
- Return structured data rather than unstructured prose alone.

### Planner (backend)
- Convert the goal into ordered, small steps.
- Specify the expected result of each step.
- Choose the next action based on the latest browser observation.
- Revise the plan after failures instead of blindly repeating actions.

### Executor (extension)
- Carry out permitted browser actions.
- Use Chrome APIs for tabs/navigation and content scripts/DOM APIs for webpage interaction where appropriate.
- Return a structured result for each action.
- Avoid actions outside the user's instruction and granted permissions.

### Validator
- Receive the expected result for the step being checked.
- Compare it with observed browser state or action results.
- Return a clear status, such as `success`, `failure`, or `uncertain`, plus evidence.
- Do not claim that an action succeeded merely because a click or command was issued.

The first version can put validation logic in the backend, the extension, or split it between them. Keep the interface explicit so this decision can be refined during implementation.

### Recovery mechanism
- Send failure details and current browser observations to the planner.
- Allow a revised plan or a safe retry.
- Stop and ask the user if the task cannot be completed safely or reliably.
- Prevent endless retries with a retry limit and task timeout.

### AI provider adapter
- Send only the context needed for the current task to the chosen model.
- Validate model output against expected schemas.
- Handle rate limits, timeouts, malformed output, and provider errors.
- Keep secrets in backend environment variables.

### Database (later)
- Store only information that the product genuinely needs, such as task status and optional task history.
- Avoid saving full webpage content or sensitive form values by default.
- Define retention and deletion behavior before enabling persistent history.

## 5. Request and Response Flow

1. The user enters an instruction in the extension.
2. The extension collects only necessary context, such as the active tab URL and selected page information, subject to permissions.
3. The extension sends the instruction and context to the FastAPI backend.
4. The analyser defines the goal and expected outcome.
5. The planner creates a structured sequence of steps.
6. The backend returns the plan or the next action to the extension.
7. The extension executes the browser action.
8. The extension observes the result and sends it back.
9. The validator checks the expected result against the observed result.
10. If successful, continue to the next step. If unsuccessful, send the failure details to the planner for recovery.
11. The extension displays completion, failure, or a request for user input.

**Important:** The Python backend cannot directly manipulate the DOM of a page open in the user's browser. The extension must execute browser interactions and report the observations to the backend.

## 6. Development Approach: End-to-End First

We will first build a **small but complete end-to-end application**. We will not build every advanced feature before testing the complete workflow.

### First working version

The first version should support simple tasks such as:
- “Open example.com.”
- “Go to YouTube and search for Python tutorials.”
- “Summarize the main information on the current webpage.”

The exact first task will be chosen before implementation begins.

### End-to-end workflow

1. The user enters an instruction in the browser extension.
2. The extension sends the instruction and necessary page context to the Python backend.
3. The backend uses the AI model to understand the task and decide what to do.
4. The backend returns a structured action or plan.
5. The extension performs the permitted browser action.
6. The extension reports what happened to the backend.
7. The system checks the result and either continues, finishes, or handles the failure.
8. The extension shows the result to the user.

**Important:** Python plans and coordinates the task. JavaScript in the extension performs browser interactions because the backend cannot directly control the DOM in the user's browser.

### Build, test, then expand

We will:
- Get the full path working for one small task.
- Test it from the extension UI through the backend and back to the user.
- Fix problems before adding more capabilities.
- Add features one at a time, testing each new feature before moving on.

We will decide the next implementation step together. Do not start implementing later features until the current step has been tested.

### Safety basics

- Keep AI API keys on the backend, never in extension code.
- Validate AI-generated actions before executing them.
- Never execute arbitrary JavaScript generated by the AI.
- Ask the user to confirm sensitive or consequential actions, such as submitting forms, sending messages, purchasing, or deleting information.
- Request only the browser permissions needed for the current feature.

## 7. First Milestone

Build and test one complete, minimal task from the extension interface to the backend and back. The first task could be opening a website or summarizing a webpage, depending on which task we choose first.

**Next step:** The project owner will choose the first task to implement. We will build only what is needed for that task, test it end to end, and then add features gradually.
