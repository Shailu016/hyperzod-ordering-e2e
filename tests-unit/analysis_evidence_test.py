import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('evidence_test_subject', pathlib.Path(__file__).parents[1] / 'scripts' / 'analysis_evidence.py')
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class EvidenceTests(unittest.TestCase):
    def test_actual_json_reporter_steps_without_category(self):
        self.assertEqual(evidence.steps_for([{'status': 'failed', 'steps': [
            {'title': 'locator.click', 'duration': 20000, 'error': {'message': 'intercepted'}}]}]),
            [{'action': 'click', 'outcome': 'failed', 'durationMs': 20000}])

    def test_steps_do_not_expose_input_values(self):
        results = [{'status': 'failed', 'steps': [
            {'category': 'pw:api', 'title': 'Fill "password=private"', 'duration': 10},
            {'category': 'pw:api', 'title': 'Click customer@example.com', 'duration': 12, 'error': {'message': 'private'}}]}]
        self.assertEqual(evidence.steps_for(results), [{'action': 'click', 'outcome': 'failed', 'durationMs': 12}])

    def test_only_contained_media_and_no_auth_images(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            (root / 'shot.png').write_bytes(b'fixture-image')
            failure = {'id': 'f', 'screenshot': 'shot.png'}
            group = {'id': 'G1', 'failureIds': ['f'], 'facts': {'intent': 'checkout'}}
            parts, labels = evidence.visual_parts([group], [failure], root)
            self.assertEqual(len(labels), 1)
            self.assertEqual(parts[1]['inlineData']['mimeType'], 'image/png')
            self.assertNotIn(str(root), str(parts))
            group['facts']['intent'] = 'create_test_account'
            self.assertEqual(evidence.visual_parts([group], [failure], root), ([], []))
            group['facts']['intent'] = 'checkout'
            failure['screenshot'] = '../shot.png'
            self.assertEqual(evidence.visual_parts([group], [failure], root), ([], []))

    def test_missing_decoder_does_not_block_report(self):
        with tempfile.TemporaryDirectory() as temp:
            (pathlib.Path(temp) / 'video.webm').write_bytes(b'fixture')
            group = {'id': 'G1', 'failureIds': ['f'], 'facts': {'intent': 'checkout'}}
            with patch.object(evidence.shutil, 'which', return_value=None):
                self.assertEqual(evidence.visual_parts([group], [{'id': 'f', 'video': 'video.webm'}], temp), ([], []))
