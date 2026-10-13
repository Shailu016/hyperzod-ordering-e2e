import importlib.util
import pathlib
import unittest
import urllib.error
import json
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("notifier", pathlib.Path(__file__).parents[1] / "scripts" / "notify-slack.py")
notifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notifier)


class NotificationTests(unittest.TestCase):
    def test_local_report_has_no_invented_github_evidence_link(self):
        payload = notifier.build_payload({'status': 'failed', 'counts': {'failed': 1}, 'origin': 'https://automations-store.hyperzod.me'}, {})
        self.assertIn('Local run', payload['blocks'][0]['text']['text'])
        self.assertNotIn('/actions/runs/', json.dumps(payload))
    def test_malformed_counts_and_incomplete_healthy_evidence_are_rejected(self):
        for summary in [[], {'status': 'passed'}, {'status': 'passed', 'counts': {'passed': 1}}, {'status': 'failed', 'counts': []}, {'status': 'failed', 'counts': {'failed': -1}}, {'status': 'failed', 'counts': {'failed': True}}, {'status': 'failed', 'finishedAt': []}, {'status': 'failed', 'projects': [{'warnings': 'bad'}]}]:
            with self.assertRaises(ValueError):
                notifier.validate_summary(summary)
        summary = {'status': 'passed', 'expectedProjects': ['web'], 'counts': {'passed': 3}, 'projects': [{'project': 'web', 'status': 'passed', 'counts': {'passed': 3}, 'critical': {'signup': 'passed', 'cod': 'passed', 'cleanup': 'passed'}}]}
        self.assertIs(notifier.validate_summary(summary), summary)
        summary['counts']['passed'] = 4
        with self.assertRaises(ValueError):
            notifier.validate_summary(summary)

    def test_retry_after_is_not_shortened_and_excessive_wait_stops_without_retry(self):
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'ok'
        opener = Mock(side_effect=[urllib.error.HTTPError('https://example.invalid', 429, 'busy', {'Retry-After': '30'}, None), response])
        wait = Mock()
        notifier.deliver({}, 'https://example.invalid/webhook', opener=opener, wait=wait)
        wait.assert_called_once_with(30.0)
        opener = Mock(side_effect=urllib.error.HTTPError('https://example.invalid', 429, 'busy', {'Retry-After': '120'}, None))
        wait = Mock()
        with self.assertRaisesRegex(RuntimeError, 'no early retry'):
            notifier.deliver({}, 'https://example.invalid/webhook', opener=opener, wait=wait)
        opener.assert_called_once()
        wait.assert_not_called()
    def test_local_disable_guard_never_attempts_delivery(self):
        with patch.dict(notifier.os.environ, {'E2E_NOTIFICATIONS_DISABLED': 'true'}), patch.object(notifier, 'deliver') as send:
            self.assertEqual(notifier.main(), 0)
            send.assert_not_called()
    def test_infrastructure_failure_and_flaky_counts_are_visible(self):
        payload = notifier.build_payload({"status": "failed", "counts": {"flaky": 1}, "issues": ["report missing"]}, {})
        self.assertIn("❌", payload["blocks"][0]["text"]["text"])
        self.assertIn("1 flaky", json.dumps(payload))
        self.assertIn("report missing", json.dumps(payload))

    def test_missing_report_cannot_be_green(self):
        self.assertIn("Infrastructure Failed", notifier.build_payload({}, {})["blocks"][0]["text"]["text"])

    def test_block_layout_aggregates_devices_and_does_not_duplicate_heading(self):
        payload = notifier.build_payload({"status": "passed", "suite": "full", "counts": {"passed": 96, "skipped": 3},
            "startedAt": "2026-10-09T04:30:00Z", "finishedAt": "2026-10-09T04:48:10Z",
            "projects": [{"project": project, "status": "passed", "counts": {"passed": 32, "skipped": 1}, "critical": {"signup": "passed", "cod": "passed", "cleanup": "passed"}} for project in ["web", "android", "ios"]]},
            {"GITHUB_REPOSITORY": "Shailu016/hyperzod-ordering-e2e", "GITHUB_RUN_ID": "123", "GITHUB_RUN_NUMBER": "21", "BASE_URL": "https://automations-store.hyperzod.me"})
        self.assertNotIn("attachments", payload)
        self.assertEqual(sum(block["type"] == "header" for block in payload["blocks"]), 1)
        self.assertIn("96 passed", payload["text"])
        self.assertIn("18m 10s", json.dumps(payload))
        self.assertIn("IST", json.dumps(payload))
        self.assertEqual(len(payload["blocks"][-1]["elements"]), 2)

    def test_untrusted_failure_text_cannot_mention_channels_or_expose_tokens(self):
        payload = notifier.build_payload({"failedTests": [{"project": "web", "title": "<!channel>", "error": "Bearer secret-token"}]}, {})
        self.assertNotIn("<!channel>", json.dumps(payload))
        self.assertNotIn("secret-token", json.dumps(payload))

    def test_delivery_requires_acknowledgement(self):
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"not-ok"
        opener, wait = Mock(return_value=response), Mock()
        with self.assertRaises(RuntimeError):
            notifier.deliver({}, "https://example.invalid/webhook", opener=opener, wait=wait)
        self.assertEqual(opener.call_count, 3)

    def test_success_uses_one_request(self):
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"ok"
        opener = Mock(return_value=response)
        notifier.deliver({}, "https://example.invalid/webhook", opener=opener)
        opener.assert_called_once()

    def test_invalid_webhook_is_not_retried(self):
        opener = Mock(side_effect=urllib.error.HTTPError("https://example.invalid", 400, "bad", {}, None))
        with self.assertRaises(RuntimeError):
            notifier.deliver({}, "https://example.invalid/webhook", opener=opener)
        opener.assert_called_once()

    def test_throttle_waits_for_retry_after(self):
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"ok"
        opener = Mock(side_effect=[urllib.error.HTTPError("https://example.invalid", 429, "busy", {"Retry-After": "2"}, None), response])
        wait = Mock()
        notifier.deliver({}, "https://example.invalid/webhook", opener=opener, wait=wait)
        wait.assert_called_once_with(2.0)
