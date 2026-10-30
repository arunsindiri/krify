import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))
import main


def groq_response(content: str):
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
    )


class SearchAutomationTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.youtube_page = {
            "title": "YouTube",
            "url": "https://www.youtube.com/",
            "visible_text": "Home Trending Subscriptions",
            "interactive_elements": [
                {
                    "index": index,
                    "type": "button",
                    "label": f"Unrelated YouTube control {index}",
                    "form_index": index,
                }
                for index in range(20)
            ] + [
                {
                    "index": 20,
                    "type": "input (text)",
                    "label": "Search",
                    "placeholder": "Search",
                    "name": "search_query",
                    "input_type": "text",
                    "search_candidate": True,
                    "searchable": True,
                    "form_index": 20,
                },
                {
                    "index": 21,
                    "type": "button",
                    "label": "Search",
                    "form_index": 20,
                    "submit_button": True,
                },
                {
                    "index": 22,
                    "type": "button",
                    "label": "Search suggestions",
                    "form_index": 22,
                    "submit_button": True,
                },
            ],
        }

    def test_youtube_style_search_plan_only_includes_search_form_candidates(self):
        expected_plan = {
            "action": "search",
            "query": "lofi music",
            "input_index": 20,
            "submit_index": 21,
            "message": "Use the YouTube search form.",
        }

        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(expected_plan)),
        ) as create:
            response = self.client.post(
                "/search-plan",
                json={"query": "lofi music", "page": self.youtube_page},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["input_index"], 20)
        self.assertEqual(response.json()["submit_index"], 21)
        model_context = create.call_args.kwargs["messages"][1]["content"]
        self.assertIn('"index": 20', model_context)
        self.assertIn('"index": 21', model_context)
        self.assertNotIn('"index": 0', model_context)
        self.assertNotIn('"index": 22', model_context)

    def test_unrelated_submit_button_is_rejected_with_actionable_message(self):
        invalid_plan = {
            "action": "search",
            "query": "lofi music",
            "input_index": 20,
            "submit_index": 22,
            "message": "Use search.",
        }

        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(invalid_plan)),
        ):
            response = self.client.post(
                "/search-plan",
                json={"query": "lofi music", "page": self.youtube_page},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["action"], "cannot_search")
        self.assertIn("not a submit button for observed search form 20", response.json()["message"])
        self.assertIn("Nothing was submitted", response.json()["message"])

    def test_invalid_search_input_is_rejected_without_submitting(self):
        invalid_plan = {
            "action": "search",
            "query": "lofi music",
            "input_index": 0,
            "submit_index": 1,
            "message": "Use search.",
        }

        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(invalid_plan)),
        ):
            response = self.client.post(
                "/search-plan",
                json={"query": "lofi music", "page": self.youtube_page},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["action"], "cannot_search")
        self.assertIn("not an eligible field", response.json()["message"])
        self.assertIn("Nothing was submitted", response.json()["message"])

    def test_unsupported_search_form_is_explained_without_calling_groq(self):
        page = {
            "title": "Unsupported form",
            "url": "https://example.test/",
            "visible_text": "Search",
            "interactive_elements": [
                {
                    "index": 0,
                    "type": "input (search)",
                    "label": "Search",
                    "input_type": "search",
                    "search_candidate": True,
                    "searchable": False,
                    "search_rejection_reason": "form method is POST, not GET",
                    "form_index": 0,
                }
            ],
        }

        with patch.object(main.client.chat.completions, "create") as create:
            response = self.client.post(
                "/search-plan",
                json={"query": "test", "page": page},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["action"], "cannot_search")
        self.assertIn("form method is POST, not GET", response.json()["message"])
        self.assertIn("same-origin GET forms only", response.json()["message"])
        create.assert_not_called()

    def test_existing_page_question_endpoint_accepts_older_observations(self):
        older_page_shape = {
            "title": "YouTube",
            "url": "https://www.youtube.com/",
            "visible_text": "Search results",
            "interactive_elements": [
                {"type": "button", "label": "Play"}
            ],
        }

        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response("The page shows search results."),
        ):
            response = self.client.post(
                "/ask-page",
                json={"question": "What is shown?", "page": older_page_shape},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["answer"], "The page shows search results.")

    def test_existing_open_website_endpoint_is_unchanged(self):
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(
                '{"action":"open_website","url":"https://www.youtube.com",'
                '"message":"Opening YouTube"}'
            ),
        ):
            response = self.client.post(
                "/task",
                json={"instruction": "Open YouTube"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["action"], "open_website")
        self.assertEqual(response.json()["url"], "https://www.youtube.com")


if __name__ == "__main__":
    unittest.main()
