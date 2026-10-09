"""Deliver the structured run outcome. Missing reports and delivery failures are explicit."""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
import re
import math
from urllib.parse import urlparse


def clean(value, limit=300):
    text = str(value)
    text = re.sub(r"(?i)(bearer\s+)[\w.\-]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)((?:password|token|authorization|secret)\s*[:=]\s*)\S+", r"\1[REDACTED]", text)
    # No notification text can create mentions or inject Slack markup.
    return text[:limit].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("`", "'")


def http_url(value):
    try:
        parsed = urlparse(value)
        if parsed.scheme in ("https", "http") and parsed.hostname and not parsed.username and not parsed.password:
            return value
    except (ValueError, TypeError):
        pass
    return None


def validate_summary(summary):
    if not isinstance(summary, dict) or summary.get('status') not in ('passed', 'failed', 'running', 'infrastructure-failed'):
        raise ValueError('Unknown report outcome')
    if any(key in summary and not isinstance(summary[key], str) for key in ('origin', 'startedAt', 'finishedAt', 'error', 'leaseReleaseError', 'leaseRetainedReason', 'suite')):
        raise ValueError('Invalid report metadata')
    def counts_valid(counts):
        return isinstance(counts, dict) and all(type(counts.get(key, 0)) is int and counts.get(key, 0) >= 0 for key in ('passed', 'failed', 'flaky', 'skipped', 'notRun'))
    counts = summary.get('counts', {})
    projects = summary.get('projects', [])
    if not counts_valid(counts) or not isinstance(projects, list):
        raise ValueError('Invalid report counts or device list')
    for project in projects:
        if not isinstance(project, dict) or not counts_valid(project.get('counts', {})) or not isinstance(project.get('critical', {}), dict) or type(project.get('warnings', 0)) is not int or project.get('warnings', 0) < 0:
            raise ValueError('Invalid device outcome')
    if not isinstance(summary.get('issues', []), list) or not all(isinstance(issue, str) for issue in summary.get('issues', [])):
        raise ValueError('Invalid run issues')
    if not isinstance(summary.get('failedTests', []), list) or not all(isinstance(item, dict) for item in summary.get('failedTests', [])):
        raise ValueError('Invalid failure evidence')
    if summary['status'] == 'passed':
        expected = summary.get('expectedProjects')
        names = [project.get('project') for project in projects]
        complete = isinstance(expected, list) and expected and all(isinstance(name, str) for name in expected + names) and set(expected) == set(names) and len(names) == len(set(names))
        healthy = counts.get('passed', 0) > 0 and not any(counts.get(key, 0) for key in ('failed', 'flaky', 'notRun')) and not summary.get('issues')
        critical = projects and all(project.get('status') == 'passed' and project.get('critical') and all(value == 'passed' for value in project['critical'].values()) for project in projects)
        aggregate = all(counts.get(key, 0) == sum(project.get('counts', {}).get(key, 0) for project in projects) for key in ('passed', 'failed', 'flaky', 'skipped', 'notRun'))
        if not (complete and healthy and critical and aggregate):
            raise ValueError('Healthy report has incomplete or inconsistent evidence')
    return summary


def build_payload(summary, context):
    counts = summary.get("counts", {})
    status = summary.get("status", "infrastructure-failed")
    label = summary.get("suite", context.get("E2E_SUITE_LABEL", "e2e"))
    number = context.get("GITHUB_RUN_NUMBER", "")
    icon = "✅" if status == "passed" else "⚠️" if status in ("running", "infrastructure-failed") else "❌"
    run_label = f'#{number}' if number else 'Local run'
    heading = f"{icon} Ordering {label} · {run_label} · {status.replace('-', ' ').title()}"
    detail = " · ".join(f"{counts.get(key, 0)} {name}" for key, name in (("passed", "passed"), ("failed", "failed"), ("skipped", "skipped"), ("flaky", "flaky"), ("notRun", "not run"))) if counts else "No complete test report available"
    repository = context.get("GITHUB_REPOSITORY", "")
    run_id = context.get("GITHUB_RUN_ID", "")
    url = f"https://github.com/{repository}/actions/runs/{run_id}" if re.fullmatch(r"[\w.-]+/[\w.-]+", repository) and str(run_id).isdigit() else ""
    issues = summary.get("issues", []) + ([summary["error"]] if summary.get("error") else [])
    if summary.get("leaseReleaseError"):
        issues.append("Account lock release failed: " + summary["leaseReleaseError"])
    if summary.get('leaseRetainedReason'):
        issues.append('Account lock retained: ' + summary['leaseRetainedReason'])
    blocks = [{"type": "header", "text": {"type": "plain_text", "text": clean(heading, 140), "emoji": True}},
              {"type": "section", "text": {"type": "mrkdwn", "text": "*Results*\n" + detail}}]
    projects = summary.get("projects", [])
    if projects:
        rows = []
        for project in projects[:8]:
            c = project.get("counts", {})
            marker = "✅" if project.get("status") == "passed" else "❌"
            rows.append(f"{marker} *{clean(project.get('project', '?'), 40)}*: {c.get('passed', 0)} passed · {c.get('failed', 0)} failed · {c.get('skipped', 0)} skipped · {c.get('notRun', 0)} not run")
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(rows)}})
        checks = [value for project in projects for value in project.get("critical", {}).values()]
        warnings = sum(project.get("warnings", 0) for project in projects)
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"Signup / COD / cleanup: {'✅ all required checks passed' if checks and all(value == 'passed' for value in checks) else '❌ incomplete or failed'} · {warnings} tests with diagnostic warnings"}]})
    failures = summary.get("failedTests", [])
    if failures:
        lines = [f"• *{clean(item.get('project'), 30)}* — {clean(item.get('title'), 180)}\n  {clean(item.get('error'), 220)}" for item in failures[:4]]
        if len(failures) > 4:
            lines.append(f"…and {len(failures) - 4} more; open evidence below")
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "*Failures*\n" + "\n".join(lines)}})
    if issues:
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "*Run issues*\n" + "\n".join("• " + clean(issue, 220) for issue in issues[:5])}})
    timing = []
    try:
        start = datetime.fromisoformat(summary["startedAt"].replace("Z", "+00:00"))
        finish = datetime.fromisoformat(summary["finishedAt"].replace("Z", "+00:00"))
        seconds = max(0, int((finish - start).total_seconds()))
        timing = [f"Duration {seconds // 60}m {seconds % 60}s", finish.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%d %b %Y · %I:%M %p IST")]
    except (KeyError, ValueError, TypeError):
        pass
    branch = context.get("GITHUB_REF_NAME", "")
    sha = context.get("GITHUB_SHA", "")[:7]
    if branch:
        timing.append(clean(branch, 80) + (f" · {clean(sha, 7)}" if sha else ""))
    if timing:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": " | ".join(timing)}]})
    buttons = []
    if url:
        buttons.append({"type": "button", "text": {"type": "plain_text", "text": "Run & evidence"}, "url": url})
    origin = http_url(summary.get("origin", context.get("BASE_URL", "")))
    if origin:
        buttons.append({"type": "button", "text": {"type": "plain_text", "text": "Open test store"}, "url": origin})
    if buttons:
        blocks.append({"type": "actions", "elements": buttons})
    # Fallback is for screen readers and notification previews; only blocks render in-channel.
    return {"text": clean(heading) + " — " + detail, "blocks": blocks, "unfurl_links": False, "unfurl_media": False}


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
                delay = float(retry_after)
            except ValueError:
                delay = 1
            if not math.isfinite(delay) or delay > 60:
                raise RuntimeError('Slack Retry-After exceeds the delivery wait budget; no early retry was sent') from None
            wait(max(0, delay))
        except (urllib.error.URLError, TimeoutError, ValueError):
            if attempt == 2:
                raise RuntimeError("Slack delivery was not acknowledged after three attempts") from None
            wait(2 ** attempt)


def main():
    if os.environ.get('E2E_NOTIFICATIONS_DISABLED') == 'true':
        print('Notifications disabled for this execution')
        return 0
    destination = sys.argv[1] if len(sys.argv) > 1 else "test-results/summary.json"
    try:
        with open(destination, encoding="utf-8") as source:
            summary = validate_summary(json.load(source))
    except (OSError, ValueError):
        summary = {"status": "infrastructure-failed", "error": "No valid run report; inspect configuration, install, runner, or cancellation steps"}
    if os.environ.get("GITHUB_RUN_ID") and str(summary.get('githubRunId', '')) != os.environ['GITHUB_RUN_ID'] and not str(summary.get("runId", "")).startswith(os.environ["GITHUB_RUN_ID"] + "-"):
        summary = {"status": "infrastructure-failed", "error": "Report is missing or belongs to another run; open workflow evidence"}
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
