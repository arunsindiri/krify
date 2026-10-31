# Click Automation Problems and Solutions

This note summarizes the problems encountered while building Click Automation and the safeguards added to address them.

## 1. AI Could Not Identify Shorts

**Problem:** Groq saw many links but could not distinguish navigation links from video links.

**Solution:** Added semantic context and candidate ranking.

**Example:** The planner can distinguish Shorts in the sidebar from Shorts video links using accessible names, destinations, and page context.

## 2. Multiple Matching Elements

**Problem:** Several elements had similar names.

**Solution:** Added ambiguity detection.

**Example:** If a page has three Settings buttons, the planner asks which one you mean instead of guessing.

## 3. Hidden Elements Could Be Selected

**Problem:** A webpage may contain invisible buttons.

**Solution:** Added visibility checks during observation and again before execution.

**Example:** A hidden Login button cannot be selected or clicked.

## 4. Disabled Elements Could Be Selected

**Problem:** Some buttons are visible but cannot be clicked.

**Solution:** Added disabled-state validation.

**Example:** A greyed-out Submit button is rejected.

## 5. Element Positions Changed

**Problem:** Websites dynamically add or remove elements, changing their positions.

**Solution:** Introduced opaque target IDs tied to the observed DOM elements.

**Example:** Instead of saying "click the 5th button," the system identifies the button by its unique target ID.

## 6. Old Target IDs Became Invalid

**Problem:** A page reload can destroy old DOM elements.

**Solution:** Added document and element validation, plus target invalidation when the page changes.

**Example:** If YouTube reloads, an old Shorts target ID cannot be reused.

## 7. Accidental Clicks

**Problem:** An AI-selected element may not be the one the user intended.

**Solution:** Added a confirmation step for supported actions. Destructive actions are blocked, not approvable.

**Example:** A proposed action must be confirmed before execution; a Delete action is rejected and cannot be approved.

## 8. Duplicate Clicks

**Problem:** A user might click Confirm twice.

**Solution:** Added single-use approval and execution protection.

**Example:** One approval allows only one click, not two.

## 9. Unsafe Actions

**Problem:** AI could trigger sensitive actions.

**Solution:** Added safety restrictions for sensitive or transactional targets.

**Example:** Purchase, payment, delete, and form-submit actions are rejected.

## 10. The Page Navigates Before Responding

**Problem:** Clicking a link may immediately unload the content script before it responds.

**Solution:** Added uncertain-dispatch handling without automatic retries.

**Example:** You click Shorts and YouTube starts navigating, but the response disappears. The extension reports that the click may have been dispatched instead of clicking again.

## 11. Large Click-Planning Requests and Provider Errors

**Problem:** Long page observations and many verbose candidates can exceed the Groq request budget. Provider failures could also appear as an unstructured server error in the Side Panel.

**Solution:** Click planning limits visible text to 1,600 UTF-8 bytes, sends at most eight ranked plausible candidates, bounds candidate fields and context, and enforces a 6,000-byte combined prompt-content ceiling. Exact-name matches and close-ranked candidates are retained; if the full plausible set cannot fit the candidate limit, planning stops and asks the user to narrow the target rather than silently dropping candidates. Groq failures return structured, sanitized JSON errors, and the Side Panel handles both JSON and non-JSON responses without exposing parse errors.

**Example:** Repeated "Settings" links remain ambiguous instead of being truncated to one candidate. A rate limit is reported as a retryable service message, without automatically retrying the request.
