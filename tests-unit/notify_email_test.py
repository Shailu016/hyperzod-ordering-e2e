import importlib.util
import os
import pathlib
import unittest
import unittest.mock

spec = importlib.util.spec_from_file_location("email_notifier", pathlib.Path(__file__).parents[1] / "scripts" / "notify-email.py")
notifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notifier)


class NotifyEmailTests(unittest.TestCase):
    def test_subject_and_body_carry_status_counts_and_failures(self):
        summary = {
            'status': 'failed', 'suite': 'smoke', 'origin': 'https://automations-store.hyperzod.me',
            'finishedAt': '2026-10-13T00:00:00Z',
            'counts': {'passed': 5, 'failed': 1, 'flaky': 0, 'skipped': 1, 'notRun': 0},
            'projects': [{'project': 'web', 'status': 'failed',
                          'counts': {'passed': 5, 'failed': 1, 'flaky': 0, 'skipped': 1, 'notRun': 0}}],
            'issues': ['web: runner failed'],
            'failedTests': [{'project': 'web', 'title': 'addresses page renders',
                             'error': 'this.getLoggedInUser is not a function'}],
        }
        subject, body = notifier.build_message(summary, 'smoke')
        self.assertIn('failed', subject)
        self.assertIn('5 passed, 1 failed', subject)
        self.assertIn('[smoke]', subject)
        self.assertIn('addresses page renders', body)
        self.assertIn('getLoggedInUser', body)

    def test_secrets_are_redacted_from_the_body(self):
        summary = {'status': 'failed', 'counts': {'failed': 1},
                   'failedTests': [{'project': 'web', 'title': 't',
                                     'error': 'login failed with Bearer abc.def-ghi and password=hunter2'}]}
        _, body = notifier.build_message(summary)
        self.assertNotIn('abc.def-ghi', body)
        self.assertNotIn('hunter2', body)
        self.assertIn('[REDACTED]', body)

    def test_missing_configuration_skips_without_sending(self):
        for env in ({}, {'MAIL_TO': 'owner@example.invalid'}):
            with self.subTest(env=env):
                with unittest.mock.patch.dict(os.environ, env, clear=True):
                    self.assertEqual(notifier.main(), 0)


if __name__ == '__main__':
    unittest.main()
