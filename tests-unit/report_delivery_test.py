import importlib.util
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
import io
import contextlib
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import report_site
import report_history
import report_source
import verify_report

spec = importlib.util.spec_from_file_location('evidence_notifier', SCRIPTS / 'notify-slack.py')
notifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notifier)


class ReportDeliveryTests(unittest.TestCase):
    def test_lock_conflict_report_has_diagnostics_without_fake_counts_or_media(self):
        self.summary = {'runId': '123-fixture', 'status': 'infrastructure-failed', 'suite': 'all', 'finishedAt': self.finished, 'startedAt': self.finished,
                        'errorCode': 'identity-lease-conflict', 'testsStarted': False,
                        'leaseConflict': {'ref': 'e2e-lease-' + 'a' * 24, 'sha': 'b' * 40, 'owner': 'local-123', 'source': 'local', 'acquiredAt': '2026-10-25T18:48:29.831Z', 'private': 'must-not-publish'}}
        report_site.write_json(self.input / 'summary.json', self.summary)
        output, metadata = self.build()
        root = output / 'bundle' / 'runs' / '123-2'
        rendered = (root / 'index.html').read_text(encoding='utf-8')
        self.assertIn('Tests did not start', rendered)
        self.assertIn('local-123', rendered)
        self.assertIn('LEASE-RECOVERY.md', rendered)
        self.assertNotIn('0 passed', rendered)
        self.assertNotIn('must-not-publish', json.dumps(metadata))
        self.assertEqual(metadata['failures'], [])
        payload = notifier.build_payload(report_site.read_json(output / 'notification.json'), self.context(output))
        text = json.dumps(payload)
        self.assertIn('Open full report', text)
        self.assertIn('Lock diagnostics in the report', text)
        self.assertNotIn('Screenshots and videos in the report', text)
        site = self.root / 'lock-history'
        report_site.assemble([output / 'bundle'], site, self.now)
        history = (site / 'index.html').read_text(encoding='utf-8')
        self.assertIn('Tests did not start', history)
        self.assertNotIn('0 passed', history)

    def test_ai_reads_inline_diagnostics_full_error_and_shows_actual_case_and_evidence(self):
        fixture = json.loads((SCRIPTS.parent / 'tests-unit/fixtures/ai-auth-application-failure.json').read_text())
        failure = fixture['failure']
        spec = self.report['suites'][0]['specs'][0]
        spec['title'] = failure['title']
        result = spec['tests'][0]['results'][0]
        result['status'] = 'failed'
        result['errors'] = fixture['errors']
        result['attachments'].append({'name': 'api-diagnostics', 'contentType': 'application/json', 'body': base64.b64encode(json.dumps(fixture['diagnostics']).encode()).decode()})
        report_site.write_json(self.project / 'report.json', self.report)
        self.summary['failedTests'][0].update(title=failure['title'], error=failure['error'])
        report_site.write_json(self.input / 'summary.json', self.summary)
        def explained(failures):
            facts = failures[0]['technicalFacts']
            self.assertEqual(facts['httpStatuses'], [200])
            self.assertEqual(facts['apiMessage'], 'Unauthorized token.')
            self.assertEqual(facts['failureKind'], 'diagnostic-guard')
            self.assertEqual(facts['apiRoutes'], ['/auth/v1/me'])
            groups = report_site.failure_analysis.evidence_groups(failures)
            value = {'schemaVersion': 1, 'status': 'complete', 'provider': 'gemini', 'model': 'gemini-3.5-flash-lite',
                'evidenceHash': report_site.failure_analysis.fingerprint(failures), 'groups': [dict(group,
                category='unknown', observation='No specific signals supplied; HTTP401.', possibleCause='Token validity or request timing needs investigation.', nextCheck='Compare the session-check request with logout completion.') for group in groups]}
            return report_site.failure_analysis.validate_analysis(value, failures)
        with patch.object(report_site.failure_analysis, 'analyze', side_effect=explained):
            output, metadata = self.build()
        root = output / 'bundle' / 'runs' / '123-2'
        rendered = (root / 'index.html').read_text(encoding='utf-8')
        self.assertIn('HTTP 200', rendered)
        self.assertIn('Unauthorized token.', rendered)
        self.assertIn(failure['title'], rendered)
        self.assertIn('Inspect evidence', rendered)
        summary = report_site.read_json(output / 'notification.json')
        self.assertIn('technicalFacts', summary['analysisEvidence'][0])
        payload = notifier.build_payload(summary, self.context(output))
        text = json.dumps(payload)
        self.assertIn('HTTP 200', text)
        self.assertIn('Unauthorized token.', text)
        self.assertIn(failure['title'], text)
        self.assertIn('Inspect evidence', text)
        self.assertNotIn('HTTP401', text)
        with patch.object(report_site.failure_analysis, 'analyze', return_value={'schemaVersion': 1, 'status': 'unavailable', 'reason': 'quota'}):
            fallback_output, fallback_metadata = self.build('quota-fallback')
        fallback_root = fallback_output / 'bundle' / 'runs' / '123-2'
        self.assertIn('HTTP 200', (fallback_root / 'index.html').read_text(encoding='utf-8'))
        fallback_payload = notifier.build_payload(report_site.read_json(fallback_output / 'notification.json'), self.context(fallback_output))
        self.assertIn('HTTP 200', json.dumps(fallback_payload))
        self.assertIn('provider quota reached', json.dumps(fallback_payload))
        self.assertEqual(fallback_metadata['counts'], self.summary['counts'])

    def test_optional_ai_reaches_html_and_slack_without_changing_result(self):
        def explained(failures):
            groups = report_site.failure_analysis.evidence_groups(failures)
            return {'schemaVersion': 1, 'status': 'complete', 'provider': 'gemini', 'model': 'gemini-3.5-flash-lite',
                'evidenceHash': report_site.failure_analysis.fingerprint(failures), 'groups': [dict(group,
                category='unknown', observation='The assertion failed.', possibleCause='Cause unknown.', nextCheck='Inspect the captured evidence.') for group in groups]}
        # An artifact cannot supply its own AI assessment.
        report_site.write_json(self.input / 'summary.json', dict(self.summary, failureAnalysis={'status': 'passed'}, analysisEvidence=['untrusted']))
        with patch.object(report_site.failure_analysis, 'analyze', side_effect=explained) as analyze:
            output, metadata = self.build()
        analyze.assert_called_once()
        self.assertEqual(metadata['status'], self.summary['status'])
        self.assertEqual(metadata['counts'], self.summary['counts'])
        self.assertEqual(metadata['failureAnalysis']['status'], 'complete')
        root = output / 'bundle' / 'runs' / '123-2'
        self.assertIn('AI explanation', (root / 'index.html').read_text(encoding='utf-8'))
        self.assertIn('Cause unknown', (root / metadata['failures'][0]['path']).read_text(encoding='utf-8'))
        summary = report_site.read_json(output / 'notification.json')
        payload = notifier.build_payload(summary, self.context(output))
        self.assertIn('AI explanation', json.dumps(payload))
        self.assertIn('Ordering full', payload['blocks'][0]['text']['text'])
        self.assertIn('Failed', payload['blocks'][0]['text']['text'])

    def test_ai_timeout_keeps_publication_and_original_failed_evidence(self):
        with patch.object(report_site.failure_analysis, 'analyze', return_value={'schemaVersion': 1, 'status': 'unavailable', 'reason': 'timeout'}):
            output, metadata = self.build()
        self.assertEqual(metadata['status'], 'failed')
        root = output / 'bundle' / 'runs' / '123-2'
        self.assertTrue((root / metadata['failures'][0]['screenshot']).is_file())
        self.assertIn('60-second limit', (root / 'index.html').read_text(encoding='utf-8'))
        payload = notifier.build_payload(report_site.read_json(output / 'notification.json'), self.context(output))
        self.assertIn('Inspect failure', json.dumps(payload))
        self.assertIn('60-second limit', json.dumps(payload))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = datetime.now(timezone.utc)
        self.finished = report_site.iso(self.now - timedelta(minutes=2))
        self.source = {'id': 123, 'run_attempt': 2, 'run_number': 7, 'head_sha': 'a' * 40, 'conclusion': 'failure'}
        self.input = self.root / 'input'
        self.project = self.input / '123-fixture' / 'ios'
        (self.project / 'html' / 'data').mkdir(parents=True)
        (self.project / 'html' / 'index.html').write_text('<html><body>Native report</body></html>')
        (self.project / 'html' / 'data' / 'image.png').write_bytes(b'image')
        (self.project / 'artifacts' / 'case').mkdir(parents=True)
        (self.project / 'artifacts' / 'case' / 'failure.png').write_bytes(b'image')
        (self.project / 'artifacts' / 'case' / 'video.webm').write_bytes(b'video')
        self.report = {'suites': [{'title': 'file', 'specs': [{'id': 'case-id', 'title': '<bad> fails', 'file': 'case.js', 'tests': [{'status': 'unexpected', 'results': [{'errors': [{'message': 'secret body not used'}], 'attachments': [
            {'contentType': 'image/png', 'path': '/home/runner/test-results/123-fixture/ios/artifacts/case/failure.png'},
            {'contentType': 'video/webm', 'path': '/home/runner/test-results/123-fixture/ios/artifacts/case/video.webm'},
        ]}]}]}]}]}
        self.summary = {'runId': '123-fixture', 'status': 'failed', 'suite': 'full', 'finishedAt': self.finished, 'startedAt': self.finished,
            'counts': {'passed': 0, 'failed': 1, 'skipped': 0, 'flaky': 0, 'notRun': 0},
            'projects': [{'project': 'ios', 'status': 'failed', 'counts': {'failed': 1}, 'critical': {}}],
            'failedTests': [{'project': 'ios', 'title': '<bad> fails', 'error': 'A real assertion <script>bad()</script>'}]}
        report_site.write_json(self.project / 'report.json', self.report)
        report_site.write_json(self.input / 'summary.json', self.summary)
        report_site.write_json(self.input / 'source.json', self.source)
        (self.input / '.env').write_text('PASSWORD=private')
        (self.input / '.auth').mkdir()
        (self.input / '.auth' / 'state.json').write_text('private auth')

    def build(self, name='prepared'):
        output = self.root / name
        metadata = report_site.prepare(self.input, output, self.source, self.now)
        return output, metadata

    def test_portable_native_reports_and_failure_media_without_raw_or_auth_files(self):
        output, metadata = self.build()
        run = output / 'bundle' / 'runs' / '123-2'
        self.assertTrue((run / 'devices' / 'ios' / 'data' / 'image.png').is_file())
        failure = metadata['failures'][0]
        self.assertEqual((run / failure['screenshot']).read_bytes(), b'image')
        self.assertEqual((run / failure['video']).read_bytes(), b'video')
        body = (run / failure['path']).read_text(encoding='utf-8')
        self.assertIn('&lt;script&gt;bad()&lt;/script&gt;', body)
        self.assertIn('<video controls playsinline', body)
        self.assertIn('poster="../evidence/', body)
        self.assertIn('id="video"', body)
        self.assertFalse(any(path.name in ('.env', '.auth', 'report.json') for path in (output / 'bundle').rglob('*')))
        self.assertNotIn('/home/runner', json.dumps(metadata))
        self.assertEqual(metadata['retentionDays'], 14)

    def test_cross_run_incomplete_and_expired_reports_are_rejected(self):
        for change in [{'runId': '999-other'}, {'runId': '../escape'}, {'finishedAt': None}, {'finishedAt': report_site.iso(self.now - timedelta(days=15))}]:
            report_site.write_json(self.input / 'summary.json', {**self.summary, **change})
            with self.assertRaises(ValueError):
                self.build()

    def test_source_attempt_and_revision_must_match_the_raw_artifact(self):
        for change in [{'id': 999}, {'run_attempt': 1}, {'head_sha': 'b' * 40}]:
            report_site.write_json(self.input / 'source.json', {**self.source, **change})
            with self.assertRaisesRegex(ValueError, 'attempt or revision'):
                self.build()

    def test_native_media_is_reused_instead_of_duplicating_recordings(self):
        for value, extension in [(b'image', 'png'), (b'video', 'webm')]:
            digest = hashlib.sha1(value).hexdigest()
            (self.project / 'html' / 'data' / (digest + '.' + extension)).write_bytes(value)
        output, metadata = self.build()
        failure = metadata['failures'][0]
        self.assertTrue(failure['video'].startswith('devices/ios/data/'))
        self.assertFalse((output / 'bundle' / 'runs' / '123-2' / 'evidence').exists())
        publication = notifier.publication_info(self.summary, self.context(output))
        self.assertIn('/devices/ios/data/', publication['failures'][0]['videoUrl'])

    def test_passing_reports_expire_after_three_days_and_infrastructure_keeps_fourteen(self):
        counts = {'passed': 1, 'failed': 0, 'skipped': 0, 'flaky': 0, 'notRun': 0}
        passed = {**self.summary, 'status': 'passed', 'counts': counts, 'failedTests': [], 'expectedProjects': ['ios'],
            'projects': [{'project': 'ios', 'status': 'passed', 'counts': counts, 'critical': {'cleanup': 'passed'}}]}
        self.report['suites'][0]['specs'][0]['tests'][0]['status'] = 'expected'
        report_site.write_json(self.project / 'report.json', self.report)
        report_site.write_json(self.input / 'summary.json', passed)
        self.source['conclusion'] = 'success'
        _, metadata = self.build()
        self.assertEqual(metadata['retentionDays'], 3)
        self.assertEqual(metadata['failures'], [])
        self.source['conclusion'] = 'failure'
        _, failed = self.build('infrastructure')
        self.assertEqual(failed['status'], 'infrastructure-failed')
        self.assertEqual(failed['retentionDays'], 14)

    def test_public_trace_archives_and_attachment_path_escape_are_rejected(self):
        trace = self.project / 'html' / 'data' / 'trace.zip'
        trace.write_bytes(b'private network trace')
        with self.assertRaisesRegex(ValueError, 'private state'):
            self.build()
        trace.unlink()
        self.report['suites'][0]['specs'][0]['tests'][0]['results'][0]['attachments'][0]['path'] = '../../../outside.png'
        report_site.write_json(self.project / 'report.json', self.report)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            self.build('other')

    def test_history_keeps_old_run_links_and_prunes_expired_content(self):
        output, metadata = self.build()
        site = self.root / 'site'
        records = report_site.assemble([output / 'bundle'], site, self.now)
        self.assertEqual(len(records), 1)
        self.assertTrue((site / 'runs' / '123-2' / 'index.html').is_file())
        empty = self.root / 'expired-site'
        records = report_site.assemble([output / 'bundle'], empty, self.now + timedelta(days=15))
        self.assertEqual(records, [])
        self.assertFalse((empty / 'runs' / '123-2').exists())

    def test_new_run_and_history_both_survive_the_next_publication(self):
        first, _ = self.build()
        self.source['run_attempt'] = 3
        report_site.write_json(self.input / 'source.json', self.source)
        second, _ = self.build('second')
        site = self.root / 'merged'
        records = report_site.assemble([second / 'bundle', first / 'bundle'], site, self.now)
        self.assertEqual({item['runKey'] for item in records}, {'123-2', '123-3'})
        for key in ['123-2', '123-3']:
            self.assertTrue((site / 'runs' / key / 'devices' / 'ios' / 'index.html').is_file())

    def test_retention_and_size_metadata_cannot_silently_extend_or_truncate_history(self):
        output, metadata = self.build()
        manifest = output / 'bundle' / 'runs' / '123-2' / 'manifest.json'
        metadata['expiresAt'] = report_site.iso(self.now + timedelta(days=100))
        report_site.write_json(manifest, metadata)
        with self.assertRaisesRegex(ValueError, 'retention'):
            report_site.assemble([output / 'bundle'], self.root / 'site', self.now)

    def test_site_capacity_failure_is_explicit(self):
        output, _ = self.build()
        with patch.object(report_site, 'MAX_SITE_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'size budget'):
                report_site.assemble([output / 'bundle'], self.root / 'site', self.now)

    def test_oversized_current_bundle_cannot_break_the_next_history_restore(self):
        with patch.object(report_site, 'MAX_BUNDLE_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'bundle size budget'):
                self.build()

    def test_interrupted_native_report_keeps_available_media_without_a_dead_link(self):
        (self.project / 'html' / 'index.html').unlink()
        output, metadata = self.build()
        failure = metadata['failures'][0]
        self.assertNotIn('nativePath', failure)
        self.assertTrue((output / 'bundle' / 'runs' / '123-2' / failure['screenshot']).is_file())
        self.assertTrue(metadata['warnings'])

    def test_history_zip_slip_and_symlinks_are_rejected(self):
        archive = self.root / 'history.zip'
        with zipfile.ZipFile(archive, 'w') as handle:
            handle.writestr('runs/../../escaped.txt', 'bad')
        with self.assertRaises(ValueError):
            report_history.safe_extract(archive, self.root / 'extract')
        with zipfile.ZipFile(archive, 'w') as handle:
            item = zipfile.ZipInfo('runs/123-2/link')
            item.create_system = 3
            item.external_attr = 0o120777 << 16
            handle.writestr(item, '/etc/passwd')
        with self.assertRaises(ValueError):
            report_history.safe_extract(archive, self.root / 'extract')

    def test_only_this_repository_main_history_artifacts_are_downloaded(self):
        artifact = {'id': 17, 'name': 'ordering-report-123-2', 'created_at': self.finished, 'expired': False, 'size_in_bytes': 1,
                    'workflow_run': {'head_branch': 'main', 'head_repository_id': 5}}
        cases = [{**artifact, 'workflow_run': {'head_branch': 'feature', 'head_repository_id': 5}},
                 {**artifact, 'workflow_run': {'head_branch': 'main', 'head_repository_id': 6}},
                 {**artifact, 'expired': True}, {**artifact, 'name': 'e2e-results-1'}]
        runner = Mock(return_value=Mock(stdout=json.dumps([{'artifacts': cases}]).encode()))
        self.assertEqual(report_history.restore('Owner/Repo', 5, self.root / 'history', run=runner, now=self.now), [])
        self.assertEqual(runner.call_count, 1)

    def test_trusted_history_is_downloaded_and_restored_without_git(self):
        output, _ = self.build()
        archive = self.root / 'valid.zip'
        with zipfile.ZipFile(archive, 'w') as handle:
            for item in (output / 'bundle').rglob('*'):
                if item.is_file():
                    handle.write(item, item.relative_to(output / 'bundle').as_posix())
        artifact = {'id': 17, 'name': 'ordering-report-123-2', 'created_at': self.finished, 'expired': False, 'size_in_bytes': archive.stat().st_size,
                    'workflow_run': {'head_branch': 'main', 'head_repository_id': 5}}
        def runner(command, **options):
            if 'stdout' in options:
                options['stdout'].write(archive.read_bytes())
                return Mock()
            return Mock(stdout=json.dumps([{'artifacts': [artifact]}]).encode())
        restored = report_history.restore('Owner/Repo', 5, self.root / 'history', run=runner, now=self.now)
        self.assertTrue((Path(restored[0]) / 'runs' / '123-2' / 'index.html').is_file())

    def test_verification_waits_for_exact_source_attempt_and_revision(self):
        _, metadata = self.build()
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps(metadata).encode()
        verify_report.verify('https://owner.github.io/repo/', metadata, opener=Mock(return_value=response), wait=Mock())
        response.read.return_value = json.dumps({**metadata, 'sourceAttempt': '1'}).encode()
        with self.assertRaises(RuntimeError):
            verify_report.verify('https://owner.github.io/repo/', metadata, opener=Mock(return_value=response), wait=Mock())

    def context(self, output):
        return {'GITHUB_REPOSITORY': 'Owner/Repo', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_NUMBER': '7', 'GITHUB_RUN_ATTEMPT': '2', 'GITHUB_SHA': 'a' * 40,
            'E2E_REPORT_PUBLISH_STATUS': 'success', 'E2E_REPORT_BASE_URL': 'https://owner.github.io/repo/', 'E2E_PUBLICATION_FILE': str(output / 'publication.json')}

    def test_slack_has_direct_report_links_screenshot_preview_and_video_link(self):
        output, metadata = self.build()
        payload = notifier.build_payload({**self.summary, 'origin': 'https://automations-store.hyperzod.me'}, self.context(output))
        rendered = json.dumps(payload)
        self.assertIn('Open full report', rendered)
        self.assertIn('View failed cases', rendered)
        self.assertIn('Watch video', rendered)
        self.assertIn('image_url', rendered)
        self.assertIn('Target:', rendered)
        self.assertIn('/runs/123-2/', rendered)
        self.assertNotIn('/home/runner', rendered)
        self.assertIn('&lt;bad&gt;', rendered)
        self.assertEqual(sum(block['type'] == 'header' for block in payload['blocks']), 1)
        self.assertLess(len(payload['blocks']), 50)
        self.assertNotIn('image_url', json.dumps(notifier.build_payload(self.summary, {**self.context(output), 'E2E_REPORT_PUBLISH_STATUS': 'failure'})))

    def test_stale_publication_cannot_link_to_a_previous_run_or_attempt(self):
        output, metadata = self.build()
        for changed in [{'GITHUB_RUN_ID': '999'}, {'GITHUB_RUN_ATTEMPT': '1'}, {'GITHUB_SHA': 'b' * 40}]:
            with self.assertRaises(ValueError):
                notifier.publication_info(self.summary, {**self.context(output), **changed})
        metadata['failures'][0]['screenshot'] = '../../private.png'
        report_site.write_json(output / 'publication.json', metadata)
        with self.assertRaises(ValueError):
            notifier.publication_info(self.summary, self.context(output))

    def test_public_urls_cannot_inject_slack_markup(self):
        output, _ = self.build()
        for base in ['https://owner.github.io/repo/|mention', 'https://owner.github.io/ x', 'https://owner.github.io/<bad>']:
            with self.assertRaises(ValueError):
                notifier.publication_info(self.summary, {**self.context(output), 'E2E_REPORT_BASE_URL': base})

    def test_failed_publication_notifier_uses_source_fallback_without_network_in_dry_run(self):
        output, _ = self.build()
        environment = {**self.context(output), 'E2E_REPORT_PUBLISHER': 'true', 'E2E_SOURCE_RUN_ID': '123', 'E2E_SOURCE_RUN_ATTEMPT': '2',
            'E2E_SOURCE_SHA': 'a' * 40, 'E2E_REPORT_PUBLISH_STATUS': 'failure', 'DRY_RUN': '1'}
        with patch.dict(os.environ, environment, clear=True), patch.object(sys, 'argv', ['notify', str(output / 'notification.json')]), patch.object(notifier, 'deliver') as deliver:
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                self.assertEqual(notifier.main(), 0)
            payload = json.loads(buffer.getvalue())
            self.assertIn('Report publishing or verification failed', json.dumps(payload))
            self.assertNotIn('Infrastructure Failed', json.dumps(payload))
            self.assertNotIn('image_url', json.dumps(payload))
            self.assertIn('actions/runs/123', json.dumps(payload))
            deliver.assert_not_called()

    def test_publisher_happy_path_uses_verified_source_evidence_without_posting(self):
        output, _ = self.build()
        environment = {**self.context(output), 'GITHUB_RUN_ID': '888', 'GITHUB_RUN_NUMBER': '99',
            'E2E_REPORT_PUBLISHER': 'true', 'E2E_SOURCE_RUN_ID': '123', 'E2E_SOURCE_RUN_NUMBER': '7', 'E2E_SOURCE_RUN_ATTEMPT': '2',
            'E2E_SOURCE_SHA': 'a' * 40, 'E2E_JOB_STATUS': 'failure', 'DRY_RUN': '1'}
        with patch.dict(os.environ, environment, clear=True), patch.object(sys, 'argv', ['notify', str(output / 'notification.json')]), patch.object(notifier, 'deliver') as deliver:
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                self.assertEqual(notifier.main(), 0)
            payload = json.loads(buffer.getvalue())
            rendered = json.dumps(payload)
            self.assertIn('Open full report', rendered)
            self.assertIn('image_url', rendered)
            self.assertIn('attempt 2', rendered)
            self.assertIn('actions/runs/123', rendered)
            self.assertNotIn('actions/runs/888', rendered)
            deliver.assert_not_called()

    def test_migration_recognizes_delivery_marker_without_duplicate_legacy_messages(self):
        self.assertEqual(report_source.delivery_mode('env:\n  REPORT_DELIVERY: pages-v1\n'), 'pages-v1')
        self.assertEqual(report_source.delivery_mode('# REPORT_DELIVERY: pages-v1\n'), 'legacy')
        self.assertEqual(report_source.delivery_mode('run: python scripts/notify-slack.py\n'), 'legacy')

    def test_source_context_links_to_e2e_run_instead_of_the_publisher(self):
        context = notifier.source_context({'GITHUB_RUN_ID': '888', 'E2E_REPORT_PUBLISHER': 'true', 'E2E_SOURCE_RUN_ID': '123', 'E2E_SOURCE_RUN_ATTEMPT': '2', 'E2E_SOURCE_SHA': 'a' * 40})
        self.assertEqual(context['GITHUB_RUN_ID'], '123')
        self.assertEqual(context['GITHUB_RUN_ATTEMPT'], '2')

    def test_forks_unknown_workflows_and_incomplete_source_runs_cannot_publish(self):
        source = {**self.source, 'head_branch': 'main', 'head_repository': {'full_name': 'Owner/Repo'}, 'status': 'completed', 'name': 'Ordering smoke · native 30 21 * * *', 'workflow_id': 375425965, 'path': '.github/workflows/scheduled-e2e-smoke.yml'}
        _, artifact = report_source.resolve({'workflow_run': source}, 'Owner/Repo')
        self.assertEqual(artifact, 'e2e-smoke-7-attempt-2')
        for change in [{'head_branch': 'feature'}, {'head_repository': {'full_name': 'Other/Repo'}}, {'path': '.github/workflows/unknown.yml'}, {'status': 'in_progress'}]:
            with self.assertRaises(ValueError):
                report_source.resolve({'workflow_run': {**source, **change}}, 'Owner/Repo')

    def test_dynamic_titles_use_stable_workflow_paths_and_verified_ids(self):
        from report_workflow import verify_workflow
        source = {**self.source, 'head_branch': 'main', 'head_repository': {'full_name': 'Owner/Repo'}, 'status': 'completed',
                  'name': 'Ordering smoke · native 30 21 * * *', 'path': '.github/workflows/scheduled-e2e-smoke.yml', 'workflow_id': 375425965}
        for title in ['Ordering smoke · native 30 21 * * *', 'Ordering smoke · manual', 'Ordering smoke · slot 2026-10-16T07:30:00.000Z']:
            metadata, artifact = report_source.resolve({'workflow_run': {**source, 'name': title}}, 'Owner/Repo')
            self.assertEqual(metadata['name'], 'scheduled-e2e-smoke')
            self.assertEqual(artifact, 'e2e-smoke-7-attempt-2')
            verify_workflow(metadata, {'id': 375425965, 'path': source['path']})
        for change in [{'id': 999}, {'path': '.github/workflows/evil.yml'}, {'id': '375425965'}]:
            with self.assertRaises(ValueError):
                verify_workflow(source, {'id': 375425965, 'path': source['path'], **change})
        for change in [{'path': '.github/workflows/evil.yml'}, {'workflow_id': '375425965'}, {'workflow_id': 0}, {'path': None}]:
            with self.assertRaises(ValueError):
                report_source.resolve({'workflow_run': {**source, **change}}, 'Owner/Repo')
        full, artifact = report_source.resolve({'workflow_run': {**source, 'name': 'Ordering full · manual', 'path': '.github/workflows/scheduled-e2e.yml', 'workflow_id': 375425968}}, 'Owner/Repo')
        self.assertEqual(full['name'], 'scheduled-e2e-full')
        self.assertEqual(artifact, 'e2e-results-7-attempt-2')

    def test_source_cli_verifies_workflow_id_before_writing_publication_outputs(self):
        source = {**self.source, 'head_branch': 'main', 'head_repository': {'full_name': 'Owner/Repo'}, 'status': 'completed',
                  'name': 'Ordering smoke · slot 2026-10-16T07:30:00.000Z', 'path': '.github/workflows/scheduled-e2e-smoke.yml', 'workflow_id': 375425965}
        event_file, output_file = self.root / 'event.json', self.root / 'output'
        event_file.write_text(json.dumps({'workflow_run': source}), encoding='utf-8')
        import base64
        marker = base64.b64encode(b'env:\n  REPORT_DELIVERY: pages-v1\n  E2E_SCHEDULE_PROTOCOL: slots-v1\n').decode()
        responses = [Mock(stdout=json.dumps({'id': 375425965, 'path': source['path']}).encode()), Mock(stdout=json.dumps({'content': marker}).encode())]
        with patch.dict(os.environ, {'GITHUB_EVENT_PATH': str(event_file), 'GITHUB_REPOSITORY': 'Owner/Repo', 'GITHUB_OUTPUT': str(output_file)}), patch.object(report_source.subprocess, 'run', side_effect=responses) as run:
            previous = Path.cwd()
            try:
                os.chdir(self.root)
                report_source.main()
            finally:
                os.chdir(previous)
            self.assertEqual(run.call_count, 2)
            self.assertIn('actions/workflows/scheduled-e2e-smoke.yml', run.call_args_list[0].args[0][-1])
        metadata = json.loads((self.root / '.report-publication/source-run.json').read_text())
        self.assertEqual(metadata['name'], 'scheduled-e2e-smoke')
        self.assertIn('artifact=e2e-smoke-7-attempt-2', output_file.read_text())
        with patch.dict(os.environ, {'GITHUB_EVENT_PATH': str(event_file), 'GITHUB_REPOSITORY': 'Owner/Repo', 'GITHUB_OUTPUT': str(output_file)}), patch.object(report_source.subprocess, 'run', return_value=Mock(stdout=b'{"id":999,"path":".github/workflows/scheduled-e2e-smoke.yml"}')) as run:
            with self.assertRaisesRegex(ValueError, 'workflow identity mismatch'):
                report_source.main()
            self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
