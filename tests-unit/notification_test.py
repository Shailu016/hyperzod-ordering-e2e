import importlib.util
import pathlib
import unittest
import urllib.error
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("notifier", pathlib.Path(__file__).parents[1] / "scripts" / "notify-slack.py")
notifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notifier)


class NotificationTests(unittest.TestCase):
    def test_infrastructure_failure_and_flaky_counts_are_visible(self):
        payload = notifier.build_payload({"status": "failed", "counts": {"flaky": 1}, "issues": ["report missing"]}, {})
        self.assertEqual(payload["attachments"][0]["color"], "danger")
        self.assertIn("1 flaky", payload["attachments"][0]["text"])
        self.assertIn("report missing", payload["attachments"][0]["text"])

    def test_missing_report_cannot_be_green(self):
        self.assertEqual(notifier.build_payload({}, {})["attachments"][0]["color"], "danger")

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
