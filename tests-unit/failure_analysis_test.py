import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
import contextlib
import urllib.error
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ai = load('ai_test_subject', 'failure_analysis.py')
site = load('ai_report_site', 'report_site.py')
notifier = load('ai_notifier', 'notify-slack.py')


class FailureAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.failures = [{'id': 'a' * 20, 'project': 'android', 'title': 'places a COD order end-to-end',
            'error': "expect(locator).toBeVisible() failed\nLocator: locator('#addAddressForm')\nTimeout: 60000ms\nError: element(s) not found"}]
        self.entry = {'id': 'G1', 'category': 'unknown', 'observation': 'The address form was not found within 60 seconds.',
            'possibleCause': 'The reason the form did not appear is unknown.', 'nextCheck': 'Inspect the dialog transition after Add New Address was clicked.'}
        self.result = {'schemaVersion': 1, 'status': 'complete', 'provider': 'gemini', 'model': ai.DEFAULT_MODEL,
            'evidenceHash': ai.fingerprint(self.failures), 'groups': [self.entry]}

    def test_no_key_disabled_and_passing_reports_never_start_provider(self):
        with patch.object(ai.subprocess, 'Popen') as start:
            self.assertEqual(ai.analyze([], {'GEMINI_API_KEY': 'test-key'})['status'], 'not-needed')
            self.assertEqual(ai.analyze(self.failures, {})['status'], 'disabled')
            self.assertEqual(ai.analyze(self.failures, {'GEMINI_API_KEY': 'test-key', 'E2E_AI_ANALYSIS_DISABLED': 'true'})['status'], 'disabled')
            start.assert_not_called()

    def test_input_is_allowlisted_not_a_redacted_raw_log(self):
        item = {**self.failures[0], 'title': 'places a COD order customer@example.com', 'error': self.failures[0]['error'] +
            '\nBearer private-token password=private-pass email=user@example.com phone=9876543210 address=Private Street lat=22.718885' +
            '\nHTTP 503 https://api.hyperzod.app/store/v1/address/PrivateName?token=private-token' +
            '\nhttps://evil.invalid/secret https://api.hyperzod.app/store/v1/private/PrivateName'}
        groups = ai.evidence_groups([item])
        encoded = json.dumps(groups)
        for private in ('private-token', 'private-pass', 'example.com', '9876543210', 'Private Street', '22.718885', 'PrivateName', 'evil.invalid'):
            self.assertNotIn(private, encoded)
        facts = groups[0]['facts']
        self.assertEqual(facts['selector'], '#addAddressForm')
        self.assertEqual(facts['apiRoutes'], ['/store/v1/address'])
        self.assertEqual(facts['httpStatuses'], [503])
        self.assertEqual(facts['timeoutMs'], 60000)

    def test_grouping_keeps_devices_and_caps_unique_groups(self):
        failures = self.failures + [{**self.failures[0], 'id': 'b' * 20, 'project': 'ios'}]
        groups = ai.evidence_groups(failures)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['devices'], ['android', 'ios'])
        self.assertEqual(len(groups[0]['failureIds']), 2)
        many = [{**self.failures[0], 'id': format(index, '020x'), 'error': 'Timeout: ' + str(index) + 'ms'} for index in range(20)]
        self.assertEqual(len(ai.evidence_groups(many)), ai.MAX_GROUPS)

    def test_worker_cannot_read_slack_github_keys_or_raw_errors(self):
        process = Mock(returncode=0)
        process.communicate.return_value = (json.dumps({'groups': [self.entry]}).encode(), b'')
        env = {'GEMINI_API_KEY': 'test-key', 'SLACK_WEBHOOK_URL': 'private-webhook', 'GH_TOKEN': 'private-gh', 'PATH': 'bin'}
        with patch.object(ai.subprocess, 'Popen', return_value=process) as start:
            result = ai.analyze(self.failures, env)
        child_env = start.call_args.kwargs['env']
        self.assertEqual(set(child_env), {'GEMINI_API_KEY', 'PATH'})
        self.assertNotIn('test-key', json.dumps(start.call_args.args))
        self.assertNotIn('element(s) not found', process.communicate.call_args.args[0].decode())
        self.assertLessEqual(process.communicate.call_args.kwargs['timeout'], 60)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['groups'][0]['failureIds'], ['a' * 20])

    def test_hard_deadline_kills_an_actually_stuck_child(self):
        real_popen = subprocess.Popen
        def sleeping_worker(*args, **kwargs):
            return real_popen([sys.executable, '-c', 'import time; time.sleep(30)'], **kwargs)
        before = time.monotonic()
        with patch.object(ai.subprocess, 'Popen', side_effect=sleeping_worker):
            result = ai.analyze(self.failures, {'GEMINI_API_KEY': 'test-key'}, timeout_seconds=0.15)
        self.assertEqual(result, {'schemaVersion': 1, 'provider': 'gemini', 'status': 'unavailable', 'reason': 'timeout'})
        self.assertLess(time.monotonic() - before, 3)

    def test_missing_truncated_injected_and_wrong_evidence_responses_fail_closed(self):
        for changes in [{'groups': []}, {'groups': [dict(self.entry, id='G99')]}, {'groups': [dict(self.entry, category='passed')]},
                        {'evidenceHash': 'another-run'}, {'groups': [dict(self.entry, nextCheck='x' * 601)]}]:
            with self.assertRaises(ValueError):
                ai.validate_analysis({**self.result, **changes}, self.failures)
        for output in [b'not json', b'{"groups": []}', b'{}']:
            process = Mock(returncode=0)
            process.communicate.return_value = (output, b'')
            with patch.object(ai.subprocess, 'Popen', return_value=process):
                self.assertEqual(ai.analyze(self.failures, {'GEMINI_API_KEY': 'test-key'})['status'], 'unavailable')

    def test_provider_is_one_request_fixed_https_origin_header_key_no_media(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': json.dumps({'groups': [self.entry]})}]}}]}).encode()
        opener = Mock()
        opener.open.return_value = response
        with patch.object(ai.urllib.request, 'build_opener', return_value=opener):
            ai.provider_request(ai.evidence_groups(self.failures), 'test-key', ai.DEFAULT_MODEL)
        opener.open.assert_called_once()
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent')
        self.assertNotIn('test-key', request.full_url)
        self.assertEqual(request.get_header('X-goog-api-key'), 'test-key')
        packet = json.loads(request.data)
        user_data = packet['contents'][0]['parts'][0]['text']
        self.assertNotIn('a' * 20, user_data)
        self.assertNotIn('inlineData', json.dumps(packet))
        self.assertIsNone(ai.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.invalid'))

    def test_ai_output_is_escaped_and_test_result_unchanged(self):
        self.entry.update(observation='<!channel> <script>bad()</script> Bearer secret-token', nextCheck='Do not disclose user@example.com')
        analysis = ai.validate_analysis(self.result, self.failures)
        summary = {'status': 'failed', 'counts': {'passed': 0, 'failed': 1}, 'failedTests': self.failures,
                   'failureAnalysis': analysis, 'analysisEvidence': self.failures}
        original = json.dumps(summary, sort_keys=True)
        payload = notifier.build_payload(summary, {})
        self.assertIn('Failed', payload['blocks'][0]['text']['text'])
        self.assertNotIn('<!channel>', json.dumps(payload))
        self.assertNotIn('secret-token', json.dumps(payload))
        self.assertEqual(json.dumps(summary, sort_keys=True), original)
        page = site.analysis_html({'failureAnalysis': analysis, 'failures': self.failures})
        self.assertIn('&lt;script&gt;', page)
        self.assertNotIn('<script>', page)
        self.assertIn('unconfirmed', page)
        self.assertNotIn('example.com', page)
        self.assertEqual(site.analysis_html({'failureAnalysis': analysis, 'failures': self.failures}, 'b' * 20), '')

    def test_timeout_and_provider_failure_are_explanatory_not_test_failures(self):
        for reason in ('timeout', 'authentication', 'quota', 'model-unavailable', 'provider-error'):
            result = {'schemaVersion': 1, 'status': 'unavailable', 'reason': reason}
            page = site.analysis_html({'failureAnalysis': result, 'failures': self.failures})
            self.assertIn('unchanged', page)
            payload = notifier.build_payload({'status': 'failed', 'failureAnalysis': result, 'analysisEvidence': self.failures}, {})
            self.assertIn('Failed', payload['blocks'][0]['text']['text'])
            self.assertIn('AI explanation unavailable', json.dumps(payload))

    def test_provider_errors_disclose_only_safe_codes_and_do_not_retry(self):
        for code, reason in [(403, 'authentication'), (404, 'model-unavailable'), (429, 'quota'), (503, 'provider-error')]:
            error = urllib.error.HTTPError('https://private.invalid', code, 'token=private-provider-body', {}, None)
            output = io.StringIO()
            with patch.object(ai.sys, 'stdin', io.StringIO(json.dumps({'groups': [], 'model': ai.DEFAULT_MODEL}))), patch.dict(ai.os.environ, {'GEMINI_API_KEY': 'test-key'}), patch.object(ai, 'provider_request', side_effect=error) as request, contextlib.redirect_stdout(output):
                ai.worker()
            self.assertEqual(json.loads(output.getvalue()), {'status': 'unavailable', 'reason': reason, 'diagnosticCode': 'HTTP_' + str(code)})
            self.assertNotIn('private', output.getvalue())
            request.assert_called_once()


if __name__ == '__main__':
    unittest.main()
