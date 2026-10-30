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


class ClickAutomationPlanningTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.page = {
            "title": "Account settings",
            "url": "https://example.test/account",
            "visible_text": "Account settings",
            "interactive_elements": [
                {
                    "index": 0,
                    "target_id": target_id(100),
                    "type": "a",
                    "label": "Profile",
                    "href": "https://example.test/profile",
                    "visible": True,
                    "disabled": False,
                },
                {
                    "index": 1,
                    "target_id": target_id(101),
                    "type": "button",
                    "label": "Show preferences",
                    "visible": True,
                    "disabled": False,
                },
            ],
        }

    def post_click_plan(self, instruction="Open my profile", page=None):
        return self.client.post(
            "/click-plan",
            json={
                "instruction": instruction,
                "page": page or self.page,
            },
        )

    def prompt_context(self, create_mock):
        content = create_mock.call_args.kwargs["messages"][1]["content"]
        serialized_context = content.split("Untrusted webpage information:\n", 1)[1]
        return json.loads(serialized_context)

    def test_selects_an_observed_navigation_link(self):
        proposal = {
            "target_id": target_id(100),
            "ambiguous": False,
            "action_description": "Open the Profile link.",
            "expected_outcome": "The profile page opens.",
            "rejection_reason": None,
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ) as create:
            response = self.post_click_plan()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {
                "valid": True,
                "target_id": target_id(100),
                "element_type": "a",
                "element_text": "Profile",
                "action_description": "Open the Profile link.",
                "expected_outcome": "The profile page opens.",
                "rejection_reason": None,
            },
        )
        prompt = create.call_args.kwargs["messages"][1]["content"]
        self.assertIn(target_id(100), prompt)
        self.assertNotIn('"index"', prompt)

    def test_selects_an_observed_safe_button(self):
        proposal = {
            "target_id": target_id(101),
            "ambiguous": False,
            "action_description": "Expand the preferences section.",
            "expected_outcome": "Preference options become visible.",
            "rejection_reason": None,
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ):
            response = self.post_click_plan(instruction="Expand preferences")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["valid"])
        self.assertEqual(response.json()["target_id"], target_id(101))
        self.assertEqual(response.json()["element_type"], "button")

    def test_navigation_link_ranks_above_same_named_video_link_without_hiding_it(self):
        navigation_target = target_id(108)
        video_target = target_id(109)
        page = {
            **self.page,
            "interactive_elements": [
                {
                    "index": 0,
                    "target_id": navigation_target,
                    "type": "a",
                    "element_tag": "a",
                    "accessible_role": "link",
                    "label": "Shorts",
                    "accessible_name": "Shorts",
                    "href": "https://example.test/shorts/",
                    "landmark_label": "Primary navigation",
                    "ancestor_context": [
                        "navigation: Primary navigation",
                        "aside: Sidebar",
                    ],
                    "visible": True,
                    "disabled": False,
                },
                {
                    "index": 1,
                    "target_id": video_target,
                    "type": "a",
                    "element_tag": "a",
                    "accessible_role": "link",
                    "label": "Shorts",
                    "accessible_name": "Shorts",
                    "href": "https://example.test/watch?v=clip",
                    "landmark_label": "Main content",
                    "ancestor_context": [
                        "main: Watch feed",
                        "article: Shorts video",
                    ],
                    "visible": True,
                    "disabled": False,
                },
                *[
                    {
                        "index": index,
                        "target_id": target_id(300 + index),
                        "type": "a",
                        "label": f"Unrelated video {index}",
                        "href": f"https://example.test/watch?v={index}",
                        "visible": True,
                        "disabled": False,
                    }
                    for index in range(2, 32)
                ],
            ],
        }
        proposal = {
            "target_id": navigation_target,
            "ambiguous": False,
            "action_description": "Open the Shorts navigation item.",
            "expected_outcome": "The Shorts page opens.",
            "rejection_reason": None,
        }

        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ) as create:
            response = self.post_click_plan(
                instruction="Click Shorts in the left sidebar navigation, below Home.",
                page=page,
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["valid"])
        context = self.prompt_context(create)
        self.assertEqual(context["eligible_candidate_count"], 32)
        self.assertLess(context["candidates_sent"], context["eligible_candidate_count"])
        candidates = context["eligible_elements"]
        self.assertEqual(candidates[0]["target_id"], navigation_target)
        self.assertEqual(candidates[0]["context_category"], "sidebar_navigation")
        self.assertEqual(candidates[0]["accessible_name"], "Shorts")
        self.assertEqual(candidates[0]["accessible_role"], "link")
        self.assertEqual(candidates[0]["landmark_label"], "Primary navigation")
        self.assertEqual(candidates[1]["target_id"], video_target)
        self.assertEqual(candidates[1]["context_category"], "video_content")

    def test_sidebar_navigation_is_distinguished_from_page_content(self):
        page = {
            **self.page,
            "interactive_elements": [
                {
                    "index": 0,
                    "target_id": target_id(110),
                    "type": "a",
                    "accessible_role": "link",
                    "element_tag": "a",
                    "label": "Library",
                    "accessible_name": "Library",
                    "href": "https://example.test/library",
                    "landmark_label": "Main navigation",
                    "ancestor_context": ["navigation: Main navigation", "aside: Sidebar"],
                    "visible": True,
                    "disabled": False,
                },
                {
                    "index": 1,
                    "target_id": target_id(111),
                    "type": "a",
                    "accessible_role": "link",
                    "element_tag": "a",
                    "label": "Library",
                    "accessible_name": "Library",
                    "href": "https://example.test/articles/library",
                    "landmark_label": "Main content",
                    "ancestor_context": ["main: Main content", "article: Library"],
                    "visible": True,
                    "disabled": False,
                },
            ],
        }
        candidates = main.build_click_candidates(main.PageObservation.model_validate(page))
        ranked = main.rank_click_candidates("Open Library in the sidebar navigation", candidates)

        self.assertEqual(ranked[0]["target_id"], target_id(110))
        self.assertEqual(ranked[0]["context_category"], "sidebar_navigation")
        self.assertEqual(ranked[1]["target_id"], target_id(111))
        self.assertEqual(ranked[1]["context_category"], "page_content")

    def test_equally_matching_links_remain_in_prompt_and_ambiguous_plan_is_rejected(self):
        page = {
            **self.page,
            "interactive_elements": [
                {
                    "index": index,
                    "target_id": target_id(112 + index),
                    "type": "a",
                    "element_tag": "a",
                    "accessible_role": "link",
                    "label": "Settings",
                    "accessible_name": "Settings",
                    "href": f"https://example.test/settings/{index}",
                    "landmark_label": "Account navigation",
                    "ancestor_context": ["navigation: Account navigation", "aside: Sidebar"],
                    "visible": True,
                    "disabled": False,
                }
                for index in range(2)
            ],
        }
        proposal = {
            "target_id": None,
            "ambiguous": True,
            "action_description": None,
            "expected_outcome": None,
            "rejection_reason": "Two Settings links match in the sidebar.",
        }

        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ) as create:
            response = self.post_click_plan(
                instruction="Open Settings in the sidebar navigation",
                page=page,
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["valid"])
        self.assertIn("Two Settings links", response.json()["rejection_reason"])
        candidates = self.prompt_context(create)["eligible_elements"]
        self.assertEqual({candidate["target_id"] for candidate in candidates}, {
            target_id(112), target_id(113)
        })

    def test_legacy_observation_without_semantic_context_still_uses_safe_fallbacks(self):
        proposal = {
            "target_id": target_id(100),
            "ambiguous": False,
            "action_description": "Open Profile.",
            "expected_outcome": "The profile page opens.",
            "rejection_reason": None,
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ) as create:
            response = self.post_click_plan()

        self.assertTrue(response.json()["valid"])
        profile = next(
            candidate for candidate in self.prompt_context(create)["eligible_elements"]
            if candidate["target_id"] == target_id(100)
        )
        self.assertEqual(profile["accessible_name"], "Profile")
        self.assertEqual(profile["accessible_role"], "link")
        self.assertEqual(profile["element_type"], "a")
        self.assertIsNone(profile["landmark_label"])
        self.assertEqual(profile["ancestor_context"], [])

    def test_malformed_target_id_is_rejected(self):
        proposal = {
            "target_id": "css-selector-for-profile",
            "ambiguous": False,
            "action_description": "Open a page.",
            "expected_outcome": "A page opens.",
            "rejection_reason": None,
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ):
            response = self.post_click_plan()

        self.assertFalse(response.json()["valid"])
        self.assertIn("not present", response.json()["rejection_reason"])

    def test_rejects_an_invalid_target_id(self):
        proposal = {
            "target_id": target_id(199),
            "ambiguous": False,
            "action_description": "Open a page.",
            "expected_outcome": "A page opens.",
            "rejection_reason": None,
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ):
            response = self.post_click_plan()

        self.assertFalse(response.json()["valid"])
        self.assertIsNone(response.json()["target_id"])
        self.assertIn("not present", response.json()["rejection_reason"])

    def test_rejects_hidden_targets(self):
        hidden_page = dict(self.page)
        hidden_page["interactive_elements"] = [
            *self.page["interactive_elements"],
            {
                "index": 2,
                "target_id": target_id(102),
                "type": "button",
                "label": "Hidden control",
                "visible": False,
                "disabled": False,
            },
        ]
        proposal = {
            "target_id": target_id(102),
            "ambiguous": False,
            "action_description": "Open the control.",
            "expected_outcome": "The control opens.",
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ):
            response = self.post_click_plan(page=hidden_page)

        self.assertFalse(response.json()["valid"])
        self.assertIn("hidden", response.json()["rejection_reason"])

    def test_rejects_disabled_targets(self):
        disabled_page = dict(self.page)
        disabled_page["interactive_elements"] = [
            *self.page["interactive_elements"],
            {
                "index": 2,
                "target_id": target_id(103),
                "type": "button",
                "label": "Disabled control",
                "visible": True,
                "disabled": True,
            },
        ]
        proposal = {
            "target_id": target_id(103),
            "ambiguous": False,
            "action_description": "Open the control.",
            "expected_outcome": "The control opens.",
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ):
            response = self.post_click_plan(page=disabled_page)

        self.assertFalse(response.json()["valid"])
        self.assertIn("disabled", response.json()["rejection_reason"])

    def test_requires_observed_enabled_state_before_planning(self):
        incomplete_page = {
            **self.page,
            "interactive_elements": [
                {
                    "index": 0,
                    "target_id": target_id(106),
                    "type": "button",
                    "label": "Open settings",
                    "visible": True,
                }
            ],
        }
        with patch.object(main.client.chat.completions, "create") as create:
            response = self.client.post(
                "/click-plan",
                json={
                    "instruction": "Open settings",
                    "page": incomplete_page,
                },
            )

        self.assertFalse(response.json()["valid"])
        self.assertIn("enabled state was not observed", response.json()["rejection_reason"])
        create.assert_not_called()

    def test_requires_observed_visibility_before_planning(self):
        incomplete_page = {
            **self.page,
            "interactive_elements": [
                {
                    "index": 0,
                    "target_id": target_id(107),
                    "type": "button",
                    "label": "Open settings",
                    "disabled": False,
                }
            ],
        }
        with patch.object(main.client.chat.completions, "create") as create:
            response = self.client.post(
                "/click-plan",
                json={
                    "instruction": "Open settings",
                    "page": incomplete_page,
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["valid"])
        self.assertIn("visibility was not observed", response.json()["rejection_reason"])
        create.assert_not_called()

    def test_rejects_destructive_button(self):
        destructive_page = dict(self.page)
        destructive_page["interactive_elements"] = [
            *self.page["interactive_elements"],
            {
                "index": 2,
                "target_id": target_id(104),
                "type": "button",
                "label": "Delete account",
                "visible": True,
                "disabled": False,
            },
        ]
        proposal = {
            "target_id": target_id(104),
            "ambiguous": False,
            "action_description": "Delete the account.",
            "expected_outcome": "The account is deleted.",
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ):
            response = self.post_click_plan(page=destructive_page)

        self.assertFalse(response.json()["valid"])
        self.assertIn("destructive", response.json()["rejection_reason"])

    def test_rejects_purchase_or_payment_instruction_without_calling_groq(self):
        with patch.object(main.client.chat.completions, "create") as create:
            response = self.post_click_plan(
                instruction="Click the purchase button to buy this item",
            )

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["valid"])
        self.assertIn("purchase", response.json()["rejection_reason"])
        create.assert_not_called()

    def test_rejects_ambiguous_instruction_without_selecting_a_target(self):
        proposal = {
            "target_id": None,
            "ambiguous": True,
            "action_description": None,
            "expected_outcome": None,
            "rejection_reason": "There are multiple matching settings sections.",
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ):
            response = self.post_click_plan(
                instruction="Open settings",
            )

        self.assertFalse(response.json()["valid"])
        self.assertIsNone(response.json()["target_id"])
        self.assertIn("multiple matching", response.json()["rejection_reason"])

    def test_rejects_a_missing_target(self):
        proposal = {
            "target_id": None,
            "ambiguous": False,
            "action_description": None,
            "expected_outcome": None,
            "rejection_reason": "No matching link was observed.",
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ):
            response = self.post_click_plan(
                instruction="Open the billing page",
            )

        self.assertFalse(response.json()["valid"])
        self.assertIsNone(response.json()["target_id"])
        self.assertIn("No matching link", response.json()["rejection_reason"])

    def test_rejects_form_submission_control(self):
        submit_page = dict(self.page)
        submit_page["interactive_elements"] = [
            *self.page["interactive_elements"],
            {
                "index": 2,
                "target_id": target_id(105),
                "type": "button",
                "label": "Continue",
                "visible": True,
                "disabled": False,
                "submit_button": True,
            },
        ]
        proposal = {
            "target_id": target_id(105),
            "ambiguous": False,
            "action_description": "Continue.",
            "expected_outcome": "The form is submitted.",
        }
        with patch.object(
            main.client.chat.completions,
            "create",
            return_value=groq_response(json.dumps(proposal)),
        ):
            response = self.post_click_plan(page=submit_page)

        self.assertFalse(response.json()["valid"])
        self.assertIn("Form submission", response.json()["rejection_reason"])


if __name__ == "__main__":
    unittest.main()
