import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import verify_report

spec = importlib.util.spec_from_file_location('delivery_notifier', SCRIPTS / 'notify-slack.py')
notifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notifier)


def response(value):
    result = Mock()
    result.__enter__ = Mock(return_value=result)
    result.__exit__ = Mock(return_value=False)
    result.read.return_value = json.dumps(value).encode()
    return result


class VerificationRegressionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        finished = datetime.now(timezone.utc) - timedelta(minutes=1)
        self.summary = {'runId': '123-fixture', 'status': 'failed', 'suite': 'all', 'counts': {'failed': 6, 'notRun': 77},
                        'finishedAt': finished.isoformat(), 'failedTests': [{'project': 'web', 'title': 'Signup', 'error': 'Maps configuration missing'}]}
        self.manifest = {'runKey': '123-2', 'sourceRunId': '123', 'sourceAttempt': '2', 'sourceSha': 'a' * 40,
                         'finishedAt': self.summary['finishedAt'], 'status': 'failed', 'retentionDays': 14,
                         'expiresAt': (finished + timedelta(days=14)).isoformat(),
                         'failures': [{'id': 'b' * 20, 'project': 'web', 'title': 'Signup', 'screenshot': 'evidence/' + 'b' * 20 + '-screenshot.png'}]}
        (self.root / 'publication.json').write_text(json.dumps(self.manifest), encoding='utf-8')
        (self.root / 'summary.json').write_text(json.dumps(self.summary), encoding='utf-8')
        self.env = {'E2E_REPORT_PUBLISHER': 'true', 'E2E_SOURCE_RUN_ID': '123', 'E2E_SOURCE_RUN_ATTEMPT': '2',
                    'E2E_SOURCE_SHA': 'a' * 40, 'E2E_SOURCE_RUN_NUMBER': '77', 'E2E_JOB_STATUS': 'failure',
                    'E2E_REPORT_PUBLISH_STATUS': 'failure', 'E2E_REPORT_DEPLOY_STATUS': 'success',
                    'E2E_REPORT_VERIFY_STATUS': 'pending', 'E2E_PUBLICATION_FILE': str(self.root / 'publication.json'),
                    'E2E_REPORT_BASE_URL': 'https://owner.github.io/repo/', 'GITHUB_REPOSITORY': 'Owner/Repo',
                    'E2E_REPORT_ARTIFACT_STATUS': 'success', 'E2E_REPORT_ARTIFACT_RUN_ID': '888', 'DRY_RUN': '1'}

    def payload(self, changes=None):
        with patch.dict(os.environ, {**self.env, **(changes or {})}, clear=True), patch.object(sys, 'argv', ['notify', str(self.root / 'summary.json')]), patch.object(notifier, 'deliver') as deliver:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(notifier.main(), 0)
            deliver.assert_not_called()
            return json.loads(output.getvalue())

    def test_delayed_pages_can_recover_after_the_previous_ten_second_window(self):
        missing = urllib.error.HTTPError('https://fixture.invalid', 404, 'not ready', {}, None)
        opener = Mock(side_effect=[missing] * 5 + [response(self.manifest)])
        wait = Mock()
        verify_report.verify('https://owner.github.io/repo/', self.manifest, opener=opener, wait=wait, log=Mock())
        self.assertEqual(opener.call_count, 6)
        self.assertEqual(sum(call.args[0] for call in wait.call_args_list), 110)
        urls = [call.args[0].full_url for call in opener.call_args_list]
        self.assertEqual(len(set(urls)), len(urls))
        self.assertTrue(all('/runs/123-2/manifest.json?verification=' in url for url in urls))

    def test_retry_budget_is_bounded_and_errors_do_not_echo_private_response_data(self):
        opener = Mock(side_effect=urllib.error.HTTPError('https://fixture.invalid?token=private', 503, 'private body', {}, None))
        wait, log = Mock(), Mock()
        with self.assertRaises(verify_report.VerificationError) as raised:
            verify_report.verify('https://owner.github.io/repo/', self.manifest, opener=opener, wait=wait, log=log)
        self.assertEqual(raised.exception.status, 'pending')
        self.assertEqual(opener.call_count, 7)
        self.assertEqual(sum(call.args[0] for call in wait.call_args_list), 170)
        self.assertLessEqual(170 + 7 * 15, 300)
        self.assertIn('HTTP 503', str(raised.exception))
        self.assertNotIn('private', str(raised.exception) + str(log.call_args_list))

    def test_wrong_identity_and_oversized_or_malformed_manifests_never_become_pending_links(self):
        for raw in [json.dumps({**self.manifest, 'sourceSha': 'c' * 40}).encode(), b'x' * (verify_report.MAX_MANIFEST_BYTES + 1), b'<html>not JSON</html>', b'\xff']:
            result = response({})
            result.read.return_value = raw
            with self.assertRaises(verify_report.VerificationError) as raised:
                verify_report.verify('https://owner.github.io/repo/', self.manifest, opener=Mock(return_value=result), wait=Mock(), log=Mock())
            self.assertEqual(raised.exception.status, 'invalid')

    def test_rate_limited_verification_does_not_probe_before_retry_after(self):
        opener = Mock(side_effect=urllib.error.HTTPError('https://fixture.invalid', 429, 'busy', {'Retry-After': '600'}, None))
        with self.assertRaises(verify_report.VerificationError) as raised:
            verify_report.verify('https://owner.github.io/repo/', self.manifest, opener=opener, wait=Mock(), log=Mock())
        self.assertEqual(raised.exception.status, 'pending')
        opener.assert_called_once()

    def test_cli_emits_pending_for_workflow_consumers_without_returning_success(self):
        output = self.root / 'outputs'
        with patch.dict(os.environ, {'GITHUB_OUTPUT': str(output)}, clear=True), patch.object(sys, 'argv', ['verify', '--base-url', 'https://owner.github.io/repo/', '--publication', str(self.root / 'publication.json')]), patch.object(verify_report, 'verify', side_effect=verify_report.VerificationError('pending', 'HTTP 404')), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(verify_report.main(), 1)
        self.assertEqual(output.read_text().strip(), 'status=pending')

    def test_pending_report_keeps_failure_status_button_and_artifact_fallback_without_thumbnails(self):
        payload = self.payload()
        rendered = json.dumps(payload)
        self.assertTrue(payload['blocks'][0]['text']['text'].endswith('Failed'))
        self.assertNotIn('Infrastructure Failed', rendered)
        self.assertIn('6 failed', rendered)
        self.assertIn('Open report (verification pending)', rendered)
        self.assertIn('runs/123-2/', rendered)
        self.assertIn('Saved report & media', rendered)
        self.assertIn('actions/runs/888#artifacts', rendered)
        self.assertIn('Report delivery', rendered)
        self.assertNotIn('image_url', rendered)

    def test_failed_deployment_invalid_identity_and_expiry_only_link_github_evidence(self):
        for changes in [{'E2E_REPORT_DEPLOY_STATUS': 'failure'}, {'E2E_REPORT_VERIFY_STATUS': 'invalid'}, {'E2E_SOURCE_SHA': 'c' * 40}]:
            payload = self.payload(changes)
            rendered = json.dumps(payload)
            self.assertNotIn('runs/123-2/', rendered)
            self.assertIn('actions/runs/888#artifacts', rendered)
            self.assertNotIn('Infrastructure Failed', rendered)
        self.manifest['expiresAt'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        (self.root / 'publication.json').write_text(json.dumps(self.manifest), encoding='utf-8')
        self.assertNotIn('runs/123-2/', json.dumps(self.payload()))

    def test_verified_failure_keeps_rich_evidence_and_passed_results_keep_their_status(self):
        payload = self.payload({'E2E_REPORT_PUBLISH_STATUS': 'success', 'E2E_REPORT_VERIFY_STATUS': 'verified'})
        self.assertIn('Open full report', json.dumps(payload))
        self.assertIn('image_url', json.dumps(payload))
        counts = {'passed': 1}
        self.summary.update(status='passed', counts=counts, failedTests=[], expectedProjects=['web'], projects=[{'project': 'web', 'status': 'passed', 'counts': counts, 'critical': {'cleanup': 'passed'}}])
        self.manifest['status'] = 'passed'
        (self.root / 'summary.json').write_text(json.dumps(self.summary), encoding='utf-8')
        (self.root / 'publication.json').write_text(json.dumps(self.manifest), encoding='utf-8')
        payload = self.payload({'E2E_JOB_STATUS': 'success'})
        self.assertTrue(payload['blocks'][0]['text']['text'].endswith('Passed'))
        self.assertTrue(self.payload()['blocks'][0]['text']['text'].endswith('Infrastructure Failed'))
        self.assertIn('verification pending', json.dumps(payload))


if __name__ == '__main__':
    unittest.main()
