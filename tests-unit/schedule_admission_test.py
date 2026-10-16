import importlib.util
import unittest
import contextlib
import io
import json
import tempfile
from unittest.mock import patch
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))

spec = importlib.util.spec_from_file_location('report_admission', Path(__file__).parents[1] / 'scripts' / 'report_admission.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ScheduleAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.source = {'id': 123, 'run_attempt': 1, 'head_sha': 'a' * 40, 'name': 'Ordering smoke · native 30 21 * * *', 'workflow_id': 375425965, 'path': '.github/workflows/scheduled-e2e-smoke.yml'}
        self.receipt = {'protocol': 'slots-v1', 'runId': '123', 'attempt': '1', 'sha': 'a' * 40, 'kind': 'smoke', 'due': '2026-10-15T07:30:00.000Z', 'ownerRunId': '123', 'ownerAttempt': '1', 'status': 'claimed', 'admitted': True}

    def test_real_manual_and_claimed_executions_publish_their_evidence(self):
        self.assertEqual(module.assess(self.receipt, self.source), {'publish': True, 'blocked': False})
        self.assertEqual(module.assess({**self.receipt, 'status': 'manual', 'due': None}, self.source), {'publish': True, 'blocked': False})

    def test_duplicate_and_expired_slots_do_not_send_fake_test_results(self):
        self.assertEqual(module.assess({**self.receipt, 'status': 'duplicate', 'admitted': False, 'ownerRunId': '456'}, self.source), {'publish': False, 'blocked': False})
        self.assertEqual(module.assess({**self.receipt, 'status': 'expired', 'admitted': False}, self.source), {'publish': False, 'blocked': False})

    def test_admission_errors_are_visible_and_cannot_be_silently_suppressed(self):
        self.assertEqual(module.assess({**self.receipt, 'status': 'error', 'admitted': False}, self.source), {'publish': True, 'blocked': True})

    def test_cross_run_cross_attempt_and_invalid_ownership_are_rejected(self):
        for change in [{'runId': '999'}, {'attempt': '2'}, {'sha': 'b' * 40}, {'status': 'duplicate', 'admitted': False}, {'admitted': False}, {'due': 'not-a-date'}]:
            with self.assertRaises(ValueError):
                module.assess({**self.receipt, **change}, self.source)

    def test_missing_receipt_cli_preserves_visible_failure_outputs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'source.json').write_text(json.dumps(self.source), encoding='utf-8')
            output = root / 'outputs'
            with patch.dict(module.os.environ, {'GITHUB_OUTPUT': str(output)}), patch('sys.argv', ['admission', '--receipt', str(root / 'missing.json'), '--source', str(root / 'source.json')]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(module.main(), 1)
            self.assertEqual(output.read_text(encoding='utf-8'), 'publish=true\nblocked=true\n')


if __name__ == '__main__':
    unittest.main()
