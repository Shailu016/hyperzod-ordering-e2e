"""Email scheduled E2E results to the owner. No Slack path.

Reads the aggregate `test-results/summary.json` produced by run-suite.js
(validated with the same contract as notify-slack.py) and sends one
plain-text email via stdlib smtplib. Nothing is sent unless MAIL_TO,
MAIL_USERNAME and MAIL_PASSWORD are all set; otherwise this exits 0 with
a skip notice so CI stays green while email is unconfigured.
E2E_NOTIFICATIONS_DISABLED=true also skips delivery.

Environment:
  MAIL_TO            recipient (the owner's GitHub email)
  MAIL_USERNAME      SMTP login (defaults to MAIL_TO; Gmail: full address)
  MAIL_PASSWORD      SMTP credential (Gmail: app password, not the login)
  MAIL_FROM          From header (defaults to MAIL_USERNAME)
  MAIL_SMTP_HOST     default smtp.gmail.com
  MAIL_SMTP_PORT     default 465
  MAIL_SMTP_SECURITY ssl (default) or starttls
  E2E_SUITE_LABEL    optional suite name for the subject
  E2E_NOTIFICATIONS_DISABLED=true disables delivery
"""
import importlib.util
import json
import os
import pathlib
import re
import smtplib
import sys
from email.message import EmailMessage

_loader = importlib.util.spec_from_file_location(
    "notify_slack", pathlib.Path(__file__).with_name("notify-slack.py"))
_slack = importlib.util.module_from_spec(_loader)
_loader.loader.exec_module(_slack)


def clean(value, limit=300):
    text = str(value)
    text = re.sub(r"(?i)(bearer\s+)[\w.\-]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)((?:password|token|authorization|secret)\s*[:=]\s*)\S+", r"\1[REDACTED]", text)
    return text[:limit]


def build_message(summary, suite_label=""):
    counts = summary.get("counts", {})
    status = summary.get("status", "infrastructure-failed")
    passed = counts.get("passed", 0)
    failed = counts.get("failed", 0)
    label = f"[{suite_label}] " if suite_label else ""
    subject = f"[E2E] {label}{status}: {passed} passed, {failed} failed"
    lines = [
        f"Status: {status}",
        f"Suite: {suite_label or summary.get('suite', 'e2e')}",
        f"Origin: {summary.get('origin', '')}",
        f"Finished: {summary.get('finishedAt', '')}",
        f"Counts: passed={passed} failed={failed} flaky={counts.get('flaky', 0)} "
        f"skipped={counts.get('skipped', 0)} notRun={counts.get('notRun', 0)}",
        "",
    ]
    for project in summary.get("projects", []):
        counts = project.get("counts", {})
        lines.append(
            f"- {project.get('project')}: {project.get('status')} "
            f"(passed={counts.get('passed', 0)} failed={counts.get('failed', 0)} "
            f"skipped={counts.get('skipped', 0)} notRun={counts.get('notRun', 0)})")
    if summary.get("issues"):
        lines += ["", "Issues:"]
        lines += [f"- {clean(issue, 220)}" for issue in summary["issues"][:10]]
    if summary.get("failedTests"):
        lines += ["", "Failed tests:"]
        for item in summary["failedTests"][:10]:
            lines.append(f"- [{item.get('project')}] {clean(item.get('title', ''), 160)}")
            if item.get("error"):
                lines.append(f"  {clean(item['error'], 300)}")
    lines += ["", "Full evidence: workflow artifacts (test-results/)."]
    return subject, "\n".join(lines)


def send(subject, body, host, port, security, username, password, sender, recipient):
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient
    message.set_content(body)
    if security == "starttls":
        with smtplib.SMTP(host, port, timeout=30) as client:
            client.starttls()
            client.login(username, password)
            client.send_message(message)
    else:
        with smtplib.SMTP_SSL(host, port, timeout=30) as client:
            client.login(username, password)
            client.send_message(message)


def main():
    if os.environ.get("E2E_NOTIFICATIONS_DISABLED") == "true":
        print("Notifications disabled for this execution")
        return 0
    recipient = os.environ.get("MAIL_TO", "").strip()
    username = os.environ.get("MAIL_USERNAME", "").strip() or recipient
    password = os.environ.get("MAIL_PASSWORD", "")
    if not recipient or not password:
        print("Email not configured (MAIL_TO/MAIL_PASSWORD missing); skipping")
        return 0
    destination = sys.argv[1] if len(sys.argv) > 1 else "test-results/summary.json"
    try:
        with open(destination, encoding="utf-8") as source:
            summary = _slack.validate_summary(json.load(source))
    except FileNotFoundError:
        print(f"No summary at {destination}; skipping")
        return 0
    subject, body = build_message(summary, os.environ.get("E2E_SUITE_LABEL", ""))
    try:
        send(subject, body,
             os.environ.get("MAIL_SMTP_HOST", "smtp.gmail.com"),
             int(os.environ.get("MAIL_SMTP_PORT", "465")),
             os.environ.get("MAIL_SMTP_SECURITY", "ssl"),
             username, password,
             os.environ.get("MAIL_FROM", "").strip() or username,
             recipient)
    except Exception as error:
        print(f"Email delivery failed: {clean(error, 200)}")
        return 1
    print(f"Emailed {summary.get('status')} report to {recipient}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
