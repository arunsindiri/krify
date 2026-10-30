import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))
import main


def target_id(index: int) -> str:
    return f"target-00000000-0000-4000-8000-{index:012x}"


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
                    "target_id": target_id(index),
                    "type": "button",
                    "label": f"Unrelated YouTube control {index}",
                    "form_index": index,
                }
                for index in range(20)
            ] + [
                {
                    "index": 20,
                    "target_id": target_id(20),
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
                    "target_id": target_id(21),
                    "type": "button",
                    "label": "Search",
                    "form_index": 20,
                    "submit_button": True,
                },
                {
                    "index": 22,
                    "target_id": target_id(22),
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
            "input_target_id": target_id(20),
            "submit_target_id": target_id(21),
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
        self.assertEqual(response.json()["input_target_id"], target_id(20))
        self.assertEqual(response.json()["submit_target_id"], target_id(21))
        model_context = create.call_args.kwargs["messages"][1]["content"]
        self.assertIn(f'"target_id": "{target_id(20)}"', model_context)
        self.assertIn(f'"target_id": "{target_id(21)}"', model_context)
        self.assertNotIn('"index":', model_context)
        self.assertNotIn(f'"target_id": "{target_id(0)}"', model_context)
        self.assertNotIn(f'"target_id": "{target_id(22)}"', model_context)

    def test_unrelated_submit_button_is_rejected_with_actionable_message(self):
        invalid_plan = {
            "action": "search",
            "query": "lofi music",
            "input_target_id": target_id(20),
            "submit_target_id": target_id(22),
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
            "input_target_id": target_id(0),
            "submit_target_id": target_id(1),
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

    def test_unknown_search_target_id_is_rejected(self):
        invalid_plan = {
            "action": "search",
            "query": "lofi music",
            "input_target_id": target_id(99),
            "submit_target_id": target_id(21),
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
        self.assertIsNone(response.json()["input_target_id"])

    def test_duplicate_target_ids_are_rejected(self):
        page = dict(self.youtube_page)
        page["interactive_elements"] = [
            dict(element, target_id=target_id(20))
            for element in self.youtube_page["interactive_elements"][:2]
        ]

        response = self.client.post(
            "/search-plan",
            json={"query": "lofi music", "page": page},
        )

        self.assertEqual(response.status_code, 422)
        self.assertIn("target IDs must be unique", response.text)

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

    def test_search_verification_finds_results_from_matching_query_and_result_evidence(self):
        after_page = {
            "title": "Search results",
            "url": "https://www.youtube.com/results?search_query=lofi+music",
            "visible_text": "Search results for lofi music",
            "interactive_elements": [],
            "search_input_values": ["lofi music"],
            "search_result_container_count": 0,
            "search_result_links": [
                {"text": "Lofi music mix", "href": "https://www.youtube.com/watch?v=one"}
            ],
        }

        with patch.object(main.client.chat.completions, "create") as create:
            response = self.client.post(
                "/verify-search",
                json={
                    "query": "lofi music",
                    "before_page": self.youtube_page,
                    "after_page": after_page,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "results_found")
        self.assertIn("result", response.json()["message"].lower())
        create.assert_not_called()

    def test_search_verification_accepts_result_containers_without_links(self):
        after_page = {
            "title": "Search results",
            "url": "https://example.test/search?q=lofi+music",
            "visible_text": "Lofi music",
            "interactive_elements": [],
            "search_input_values": ["lofi music"],
            "search_result_container_count": 2,
        }

        with patch.object(main.client.chat.completions, "create") as create:
            response = self.client.post(
                "/verify-search",
                json={
                    "query": "lofi music",
                    "before_page": self.youtube_page,
                    "after_page": after_page,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "results_found")
        self.assertIn("2 result container", response.json()["message"])
        create.assert_not_called()

    def test_search_verification_detects_explicit_no_results_for_matching_query(self):
        after_page = {
            "title": "Search results",
            "url": "https://example.test/search?q=unicorn+astronaut",
            "visible_text": "No results found for unicorn astronaut.",
            "interactive_elements": [],
            "search_input_values": ["unicorn astronaut"],
        }

        with patch.object(main.client.chat.completions, "create") as create:
            response = self.client.post(
                "/verify-search",
                json={
                    "query": "unicorn astronaut",
                    "before_page": self.youtube_page,
                    "after_page": after_page,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "no_results")
        self.assertIn("no results", response.json()["message"].lower())
        create.assert_not_called()

    def test_search_verification_rejects_results_for_a_mismatched_query(self):
        after_page = {
            "title": "Search results",
            "url": "https://www.youtube.com/results?search_query=other+music",
            "visible_text": "Search results for other music",
            "interactive_elements": [],
            "search_input_values": ["other music"],
            "search_result_container_count": 4,
            "search_result_links": [
                {"text": "Other music", "href": "https://www.youtube.com/watch?v=two"}
            ],
        }

        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(
                '{"status":"results_found","message":"Results are visible."}'
            ),
        ) as create:
            response = self.client.post(
                "/verify-search",
                json={
                    "query": "lofi music",
                    "before_page": self.youtube_page,
                    "after_page": after_page,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "uncertain")
        self.assertIn("does not match", response.json()["message"].lower())
        create.assert_not_called()

    def test_search_verification_does_not_trust_url_change_alone(self):
        after_page = {
            "title": "Search results",
            "url": "https://www.youtube.com/results?search_query=lofi+music",
            "visible_text": "Loading...",
            "interactive_elements": [],
        }

        with patch.object(main.client.chat.completions, "create") as create:
            response = self.client.post(
                "/verify-search",
                json={
                    "query": "lofi music",
                    "before_page": self.youtube_page,
                    "after_page": after_page,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "uncertain")
        self.assertIn("not enough", response.json()["message"].lower())
        create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
