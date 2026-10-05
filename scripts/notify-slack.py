#!/usr/bin/env python3
"""Post the latest E2E report summary to Slack via incoming webhook.

Reads test-results/junit.xml (Playwright JUnit reporter), builds a short
pass/fail summary with the failing test names, and POSTs it to Slack.
Exits 0 silently when SLACK_WEBHOOK_URL is unset (e.g. local runs) or when
no junit.xml exists - notifications must never fail a test run.

Env:
  SLACK_WEBHOOK_URL - Slack incoming-webhook URL (GitHub secret).
  E2E_SUITE_LABEL   - human label, e.g. "full matrix" / "smoke".
  BASE_URL          - store under test (shown in the message).
  GitHub context (optional): GITHUB_SERVER_URL, GITHUB_REPOSITORY,
  GITHUB_RUN_ID, GITHUB_RUN_NUMBER - used to link the run.
"""
import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET

JUNIT = os.path.join("test-results", "junit.xml")


def main() -> int:
    webhook = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not webhook:
        print("notify-slack: no SLACK_WEBHOOK_URL, skipping")
        return 0
    if not os.path.exists(JUNIT):
        print("notify-slack: no test-results/junit.xml, skipping")
        return 0

    try:
        root = ET.parse(JUNIT).getroot()
    except Exception as exc:  # noqa: BLE001 - diagnostics only
        print(f"notify-slack: cannot parse junit.xml: {exc}")
        return 0

    suites = list(root.iter("testsuite"))
    tests = sum(int(s.get("tests", 0)) for s in suites)
    failures = sum(int(s.get("failures", 0)) for s in suites)
    errors = sum(int(s.get("errors", 0)) for s in suites)
    skipped = sum(int(s.get("skipped", 0)) for s in suites)
    bad = failures + errors
    passed = max(tests - bad - skipped, 0)

    failed_names = []
    for tc in root.iter("testcase"):
        if tc.find("failure") is not None or tc.find("error") is not None:
            name = tc.get("classname", "") + " :: " + (tc.get("name", "") or "?")
            failed_names.append(name)
            if len(failed_names) >= 8:
                break

    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_no = os.environ.get("GITHUB_RUN_NUMBER", "")
    run_url = f"{server}/{repo}/actions/runs/{run_id}" if repo and run_id else ""
    suite = os.environ.get("E2E_SUITE_LABEL", "e2e")
    target = os.environ.get("BASE_URL", "")

    ok = bad == 0
    header = (
        f"{':white_check_mark:' if ok else ':x:'} "
        f"E2E {suite} #{run_no or '?'}: "
        f"{passed} passed, {bad} failed, {skipped} skipped"
    )
    lines = [header, f"Target: {target or '(default)'}"]
    if failed_names:
        lines.append("Failed:")
        lines.extend(f"• {n}"[:220] for n in failed_names)
        if bad > len(failed_names):
            lines.append(f"• …and {bad - len(failed_names)} more (see report)")
    if run_url:
        lines.append(f"Run + evidence: {run_url}")

    payload = {
        "text": header,
        "attachments": [
            {
                "color": "good" if ok else "danger",
                "text": "\n".join(lines),
            }
        ],
    }
    try:
        req = urllib.request.Request(
            webhook,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20):
            pass
    except Exception as exc:  # noqa: BLE001 - diagnostics only
        print(f"notify-slack: POST failed: {exc}")
        return 0
    print(f"notify-slack: posted ({passed}p/{bad}f/{skipped}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
