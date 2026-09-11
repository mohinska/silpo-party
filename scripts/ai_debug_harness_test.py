import io
import unittest
from contextlib import redirect_stdout

from scripts.ai_debug_harness import authorization_url, print_result, redact, require_local_harness_url


class AiDebugHarnessTest(unittest.TestCase):
    def test_authorization_url_uses_pkce_and_loopback_redirect(self) -> None:
        url = authorization_url(
            client_id="client",
            redirect_uri="http://127.0.0.1:8765/callback",
            state="state",
            verifier="v" * 43,
        )

        self.assertIn("code_challenge=", url)
        self.assertIn("code_challenge_method=S256", url)
        self.assertIn("redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback", url)
        self.assertIn("resource=https%3A%2F%2Fmcp.silpo.ua", url)

    def test_redaction_removes_tokens_and_raw_payloads(self) -> None:
        value = redact({"access_token": "secret", "trace": [{"name": "Вода"}], "raw": {"authorization": "secret"}})

        self.assertEqual(value, {"trace": [{"name": "Вода"}]})
        self.assertNotIn("secret", str(value))

    def test_non_local_harness_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            require_local_harness_url("https://example.com/api/ai-debug/harness")

    def test_human_report_keeps_candidate_choice_and_cart_details(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            print_result({
                "reply": "Додано.",
                "trace": [
                    {"toolName": "searchProducts", "status": "completed", "durationMs": 120, "selectedEvidenceId": None, "errorCode": None,
                     "trace": {"queries": ["вода", "water"], "preselection": {"status": "completed", "normalizedIntent": {"productKind": "вода", "requestedAttributes": [], "exclusions": ["солодкий напій"]}}, "candidates": [{"name": "Вода", "unit": "1 л", "unitPriceCents": 3000, "discountCents": 500, "available": True, "productId": "product", "evidenceId": "evidence", "preselection": {"evidenceId": "evidence", "verdict": "match", "reason": "Питна вода."}}]}},
                    {"toolName": "addProduct", "status": "completed", "durationMs": 2, "selectedEvidenceId": "evidence", "errorCode": None, "trace": None},
                ],
                "cart": {"revision": 1, "totalCents": 3000, "items": [{"name": "Вода", "unit": "1 л", "quantity": 1, "unitPriceCents": 3000, "productId": "product", "evidenceId": "evidence"}]},
            })

        report = output.getvalue()
        self.assertIn("Відповідь агента", report)
        self.assertIn("1. searchProducts · готово · 120 мс", report)
        self.assertIn("Запити: вода · water", report)
        self.assertIn("Вода · 1 л · 30,00 ₴ · економія 5,00 ₴", report)
        self.assertIn("Preagent: готово · тип: вода · виключено: солодкий напій", report)
        self.assertIn("Відбір: match · Питна вода.", report)
        self.assertIn("Обраний evidence: evidence", report)
        self.assertIn("Кошик · версія 1 · разом 30,00 ₴", report)

    def test_human_report_renders_sourced_recipe_without_raw_payload(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            print_result({
                "reply": "Рецепт додано.",
                "trace": [{"toolName": "resolveRecipe", "status": "completed", "durationMs": 85, "selectedEvidenceId": None, "errorCode": None, "trace": None,
                           "recipe": {"title": "Карбонара", "sourceUrl": "https://silpo.ua/recipes/carbonara", "servings": 2,
                                      "ingredients": [{"name": "Спагеті", "quantity": 200, "unit": "g", "optional": False}, {"name": "Сіль", "quantity": 1, "unit": "piece", "optional": False}],
                                      "raw": {"authorization": "private"}}}],
                "cart": {"revision": 0, "totalCents": 0, "items": []},
            })

        report = output.getvalue()
        self.assertIn("Рецепт: Карбонара · 2 порц.", report)
        self.assertIn("Джерело: https://silpo.ua/recipes/carbonara", report)
        self.assertIn("• Спагеті · 200 г", report)
        self.assertNotIn("private", report)


if __name__ == "__main__":
    unittest.main()
