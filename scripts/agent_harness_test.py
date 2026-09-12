import io
import unittest
from contextlib import redirect_stdout

from scripts.agent_harness import authorization_url, print_result, redact, require_local_url


class AgentHarnessTest(unittest.TestCase):
    def test_authorization_url_uses_pkce_and_loopback_redirect(self) -> None:
        url = authorization_url(client_id="client", redirect_uri="http://127.0.0.1:8765/callback", state="state", verifier="v" * 43)
        self.assertIn("code_challenge_method=S256", url)
        self.assertIn("resource=https%3A%2F%2Fmcp.silpo.ua", url)

    def test_non_local_harness_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            require_local_url("https://example.com/api/agent-harness")

    def test_redaction_removes_tokens_and_raw_payloads(self) -> None:
        value = redact({"access_token": "secret", "trace": [{"stage": "intent"}], "raw": {"authorization": "secret"}})
        self.assertEqual(value, {"trace": [{"stage": "intent"}]})

    def test_human_report_renders_product_candidates(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            print_result({"reply": "Шукаю.", "trace": [{"stage": "product_search", "status": "completed", "durationMs": 12, "output": {"query": "молоко", "candidates": [{"name": "Молоко 2.5%", "displayRatio": "900 мл", "priceCents": 4299, "productId": "sku-1"}]}}]})
        report = output.getvalue()
        self.assertIn("product_search · готово · 12 мс", report)
        self.assertIn("Молоко 2.5%", report)
        self.assertIn("42,99 ₴", report)


if __name__ == "__main__":
    unittest.main()
