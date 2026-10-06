"""Deliver the structured run outcome. Missing reports and delivery failures are explicit."""
import json
import os
import sys
import time
import urllib.error
import urllib.request


def build_payload(summary, context):
    counts = summary.get("counts", {})
    status = summary.get("status", "infrastructure-failed")
    label = summary.get("suite", context.get("E2E_SUITE_LABEL", "e2e"))
    number = context.get("GITHUB_RUN_NUMBER", "?")
    header = f"E2E {label} #{number}: {status}"
    detail = ", ".join(f"{counts.get(key, 0)} {key}" for key in ("passed", "failed", "flaky", "skipped", "notRun"))
    repository = context.get("GITHUB_REPOSITORY", "")
    run_id = context.get("GITHUB_RUN_ID", "")
    url = f"https://github.com/{repository}/actions/runs/{run_id}" if repository and run_id else ""
    issues = summary.get("issues", []) + ([summary["error"]] if summary.get("error") else [])
    lines = [header, detail, "Target: " + summary.get("origin", context.get("BASE_URL", "unavailable"))]
    lines.extend(str(issue)[:300] for issue in issues[:8])
    if url:
        lines.append("Run and evidence: " + url)
    return {"text": header, "attachments": [{"color": "good" if status == "passed" else "danger", "text": "\n".join(lines)}]}


def deliver(payload, webhook, opener=None, wait=None):
    opener = opener or urllib.request.urlopen
    wait = wait or time.sleep
    for attempt in range(3):
        request = urllib.request.Request(webhook, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        try:
            with opener(request, timeout=10) as response:
                if response.status != 200 or response.read().strip() != b"ok":
                    raise ValueError("Slack did not acknowledge the message")
            return
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise RuntimeError(f"Slack delivery failed (HTTP {error.code})") from None
            retry_after = error.headers.get("Retry-After", "1")
            try:
                delay = min(float(retry_after), 10)
            except ValueError:
                delay = 1
            wait(max(0, delay))
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == 2:
                raise RuntimeError("Slack delivery was not acknowledged after three attempts") from None
            wait(2 ** attempt)


def main():
    destination = sys.argv[1] if len(sys.argv) > 1 else "test-results/summary.json"
    try:
        with open(destination, encoding="utf-8") as source:
            summary = json.load(source)
    except (OSError, ValueError):
        summary = {"status": "infrastructure-failed", "error": "No valid run report; inspect configuration, install, runner, or cancellation steps"}
    if os.environ.get("E2E_JOB_STATUS") in ("failure", "cancelled") and summary.get("status") == "passed":
        summary = dict(summary, status="infrastructure-failed", error="Workflow infrastructure failed after tests")
    payload = build_payload(summary, os.environ)
    if os.environ.get("DRY_RUN") == "1":
        print(json.dumps(payload))
        return 0
    webhook = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not webhook:
        print("Notification delivery failed: SLACK_WEBHOOK_URL is missing", file=sys.stderr)
        return 1
    try:
        deliver(payload, webhook)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    print("Notification delivery acknowledged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
