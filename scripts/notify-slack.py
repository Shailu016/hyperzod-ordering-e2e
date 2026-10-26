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
import importlib.util
from urllib.parse import urlparse
from pathlib import Path

_ai_spec = importlib.util.spec_from_file_location('failure_analysis', Path(__file__).with_name('failure_analysis.py'))
failure_analysis = importlib.util.module_from_spec(_ai_spec)
_ai_spec.loader.exec_module(failure_analysis)


def clean(value, limit=300):
    text = str(value)
    text = re.sub(r"(?i)(bearer\s+)[\w.\-]+", r"\1[REDACTED]", text)
    text = re.sub(r"(?i)((?:password|token|authorization|secret)\s*[:=]\s*)\S+", r"\1[REDACTED]", text)
    # No notification text can create mentions or inject Slack markup.
    return text[:limit].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("`", "'")


def http_url(value):
    try:
        parsed = urlparse(value)
        if parsed.scheme in ("https", "http") and parsed.hostname and not parsed.username and not parsed.password and not re.search(r'[\s<>|\\]', value):
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
    if 'reportType' in summary:
        if summary['reportType'] != 'schedule-monitor' or summary['status'] != 'infrastructure-failed' or summary.get('counts') or summary.get('projects') or not summary.get('issues'):
            raise ValueError('Invalid schedule alert')
        try:
            checked = datetime.fromisoformat(summary['checkedAt'].replace('Z', '+00:00'))
            if checked.tzinfo is None:
                raise ValueError('Missing schedule check timezone')
        except (KeyError, AttributeError, ValueError):
            raise ValueError('Invalid schedule check time') from None
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


def source_context(environment):
    context = dict(environment)
    if environment.get('E2E_REPORT_PUBLISHER') == 'true':
        source_id = environment.get('E2E_SOURCE_RUN_ID', '')
        attempt = environment.get('E2E_SOURCE_RUN_ATTEMPT', '')
        if not source_id.isdigit() or not attempt.isdigit() or int(attempt) < 1:
            raise ValueError('Invalid source run for report notification')
        for field in ('RUN_ID', 'RUN_NUMBER', 'RUN_ATTEMPT', 'SHA', 'REF_NAME'):
            context['GITHUB_' + field] = environment.get('E2E_SOURCE_' + field, '')
    return context


def publication_info(summary, context):
    verified = context.get('E2E_REPORT_PUBLISH_STATUS') == 'success'
    pending = context.get('E2E_REPORT_DEPLOY_STATUS') == 'success' and context.get('E2E_REPORT_VERIFY_STATUS') == 'pending'
    if summary.get('reportType') == 'schedule-monitor' or not (verified or pending):
        return None
    base = http_url(context.get('E2E_REPORT_BASE_URL', ''))
    if not base or urlparse(base).scheme != 'https' or urlparse(base).query or urlparse(base).fragment:
        raise ValueError('Invalid public report URL')
    data = json.loads(Path(context['E2E_PUBLICATION_FILE']).read_text(encoding='utf-8'))
    key = context.get('GITHUB_RUN_ID', '') + '-' + context.get('GITHUB_RUN_ATTEMPT', '')
    if not re.fullmatch(r'\d+-[1-9]\d*', key) or any(data.get(field) != value for field, value in {
        'runKey': key, 'sourceRunId': context.get('GITHUB_RUN_ID'), 'sourceAttempt': context.get('GITHUB_RUN_ATTEMPT'),
        'sourceSha': context.get('GITHUB_SHA'), 'finishedAt': summary.get('finishedAt'), 'status': summary.get('status'),
    }.items()):
        raise ValueError('Public evidence belongs to another source run, attempt or revision')
    expiry = datetime.fromisoformat(data['expiresAt'].replace('Z', '+00:00'))
    if expiry.tzinfo is None or expiry <= datetime.now(timezone.utc):
        raise ValueError('Public evidence has expired')
    root = base.rstrip('/') + '/runs/' + key + '/'
    details = []
    for item in data.get('failures', []):
        if not re.fullmatch(r'[a-f0-9]{20}', item.get('id', '')):
            raise ValueError('Invalid failure evidence identity')
        detail = dict(item, url=root + 'failures/' + item['id'] + '.html')
        for kind, extensions in [('screenshot', 'png|jpg'), ('video', 'webm|mp4')]:
            if item.get(kind):
                standalone = 'evidence/' + item['id'] + '-' + kind + r'\.(' + extensions + ')'
                native = r'devices/(web|android|ios|setup)/data/[a-f0-9]{40}\.(' + extensions + ')'
                if not re.fullmatch(standalone, item[kind]) and not (re.fullmatch(native, item[kind]) and item[kind].split('/')[1] == item.get('project')):
                    raise ValueError('Invalid evidence media path')
                detail[kind + 'Url'] = root + item[kind]
        details.append(detail)
    return {'verified': verified, 'url': root, 'failedUrl': root + '#failures', 'expiresAt': data['expiresAt'], 'retentionDays': data['retentionDays'], 'failures': details}


def build_payload(summary, context):
    admission_blocked = context.get('E2E_EXECUTION_BLOCKED') == 'true'
    admission_rejected = admission_blocked and context.get('E2E_ADMISSION_REJECTED') == 'true'
    publication = None if admission_blocked else publication_info(summary, context)
    counts = summary.get("counts", {})
    status = summary.get("status", "infrastructure-failed")
    label = summary.get("suite", context.get("E2E_SUITE_LABEL", "e2e"))
    label = "full" if label == "all" else label
    number = context.get("GITHUB_RUN_NUMBER", "")
    icon = "✅" if status == "passed" else "⚠️" if status in ("running", "infrastructure-failed") else "❌"
    run_label = f'#{number}' if number else 'Local run'
    attempt = context.get('GITHUB_RUN_ATTEMPT', '')
    if attempt.isdigit() and int(attempt) > 1:
        run_label += f' · attempt {attempt}'
    schedule_monitor = summary.get('reportType') == 'schedule-monitor'
    heading = f"{icon} Ordering {label} · {run_label} · {'Schedule Alert' if schedule_monitor else status.replace('-', ' ').title()}"
    if admission_blocked:
        heading = f"⚠️ Ordering schedule · {run_label} · {'Execution blocked' if admission_rejected else 'Execution unverified'}"
    detail = " · ".join(f"{counts.get(key, 0)} {name}" for key, name in (("passed", "passed"), ("failed", "failed"), ("skipped", "skipped"), ("flaky", "flaky"), ("notRun", "not run"))) if counts else "No complete test report available"
    if admission_blocked:
        detail = 'Tests did not start because schedule admission was rejected. No test report, screenshots or videos were generated.' if admission_rejected else 'Execution could not be verified because its admission receipt is missing or invalid. Test outcome is unknown; inspect the source workflow.'
    if schedule_monitor:
        detail = 'Scheduled execution is missing, delayed or interrupted. Check the schedule issue below; this monitor does not report a storefront test failure.'
    repository = context.get("GITHUB_REPOSITORY", "")
    run_id = context.get("GITHUB_RUN_ID", "")
    url = f"https://github.com/{repository}/actions/runs/{run_id}" if re.fullmatch(r"[\w.-]+/[\w.-]+", repository) and str(run_id).isdigit() else ""
    issues = summary.get("issues", []) + ([summary["error"]] if summary.get("error") else [])
    if summary.get("leaseReleaseError"):
        issues.append("Account lock release failed: " + summary["leaseReleaseError"])
    if summary.get('leaseRetainedReason'):
        issues.append('Account lock retained: ' + summary['leaseRetainedReason'])
    blocks = [{"type": "header", "text": {"type": "plain_text", "text": clean(heading, 140), "emoji": True}},
              {"type": "section", "text": {"type": "mrkdwn", "text": ("*Schedule status*\n" if schedule_monitor or admission_blocked else "*Results*\n") + detail}}]
    target = http_url(summary.get('origin', context.get('BASE_URL', '')))
    if target and publication:
        blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': 'Target: <' + target + '|' + clean(urlparse(target).hostname, 150) + '>'}]})
    projects = [] if admission_blocked else summary.get("projects", [])
    if projects:
        rows = []
        for project in projects[:8]:
            c = project.get("counts", {})
            marker = "✅" if project.get("status") == "passed" else "❌"
            device = {'web': 'Desktop Chrome', 'android': 'Android', 'ios': 'iOS'}.get(project.get('project'), project.get('project', '?'))
            rows.append(f"{marker} *{clean(device, 40)}*: {c.get('passed', 0)} passed · {c.get('failed', 0)} failed" + (f" · {c.get('skipped', 0)} skipped" if c.get('skipped') else '') + (f" · {c.get('notRun', 0)} not run" if c.get('notRun') else ''))
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(rows)}})
        checks = [value for project in projects for value in project.get("critical", {}).values()]
        warnings = sum(project.get("warnings", 0) for project in projects)
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"Required lifecycle checks: {'✅ all passed' if checks and all(value == 'passed' for value in checks) else '❌ incomplete or failed'} · {warnings} tests with diagnostic warnings"}]})
    failures = [] if admission_blocked else summary.get("failedTests", [])
    if publication and publication['verified'] and publication['failures']:
        blocks.append({'type': 'section', 'text': {'type': 'mrkdwn', 'text': '*Failed cases*'}})
        for index, item in enumerate(publication['failures'][:3]):
            device = {'web': 'Desktop Chrome', 'android': 'Android', 'ios': 'iOS'}.get(item.get('project'), item.get('project', '?'))
            observed = failure_analysis.observation_for(failure_analysis.facts_for(item), [item.get('project')])
            message = f"*{index + 1}. {clean(device, 40)} · {clean(item.get('title'), 180)}*\n{clean(observed or str(item.get('error', '')).split(chr(10) + chr(10))[0], 350)}\n<{item['url']}|Inspect failure>"
            if item.get('screenshotUrl'):
                message += f" · <{item['screenshotUrl']}|View screenshot>"
            if item.get('videoUrl'):
                message += f" · <{item['url']}#video|Watch video>"
            block = {'type': 'section', 'text': {'type': 'mrkdwn', 'text': message}}
            if index < 2 and item.get('screenshotUrl'):
                block['accessory'] = {'type': 'image', 'image_url': item['screenshotUrl'], 'alt_text': clean('Failure screenshot: ' + item.get('title', ''), 300)}
            blocks.append(block)
        if len(publication['failures']) > 3:
            blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': f"{len(publication['failures']) - 3} more failed cases in the full report"}]})
    elif failures:
        lines = [f"• *{clean(item.get('project'), 30)}* — {clean(item.get('title'), 180)}\n  {clean(item.get('error'), 220)}" for item in failures[:4]]
        if len(failures) > 4:
            lines.append(f"…and {len(failures) - 4} more; open evidence below")
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "*Failures*\n" + "\n".join(lines)}})
    if not schedule_monitor and not admission_blocked and summary.get('failureAnalysis'):
        try:
            analysis = failure_analysis.validate_analysis(summary['failureAnalysis'], summary.get('analysisEvidence', []))
        except (ValueError, TypeError, KeyError):
            analysis = {'status': 'unavailable'}
        if analysis['status'] == 'complete':
            blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': 'AI explanation · advisory · based on diagnostic facts; screenshots/videos were not sent to AI. Possible causes are unconfirmed.'}]})
            for group in analysis['groups'][:3]:
                devices = ' / '.join({'web': 'Desktop Chrome', 'android': 'Android', 'ios': 'iOS', 'setup': 'Signup'}[name] for name in group['devices'])
                assessment = 'Cause unknown' if group['category'] == 'unknown' else group['category'].title() + ' (suspected)'
                evidence = [item for item in summary.get('analysisEvidence', []) if item.get('id') in group['failureIds']]
                titles = list(dict.fromkeys(clean(item.get('title', ''), 180) for item in evidence))
                cases = '\n*Case:* ' + '; '.join(titles[:2]) if titles else ''
                links = [item for item in (publication['failures'] if publication and publication['verified'] else []) if item['id'] in group['failureIds']]
                evidence_link = '\n' + ' · '.join('<' + item['url'] + '|Inspect evidence>' for item in links[:2]) if links else ''
                text = f"*{clean(devices, 80)} · {clean(assessment, 60)}*{cases}\n*Observation:* {clean(group['observation'], 350)}\n*Possible cause:* {clean(group['possibleCause'], 350)}\n*Next check:* {clean(group['nextCheck'], 350)}{evidence_link}"
                blocks.append({'type': 'section', 'text': {'type': 'mrkdwn', 'text': text}})
            if len(analysis['groups']) > 3:
                blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': 'More AI explanations are available in the full report.'}]})
        elif analysis['status'] == 'unavailable':
            reason = {'timeout': '60-second limit reached', 'authentication': 'API key not accepted', 'quota': 'provider quota reached', 'model-unavailable': 'configured model unavailable'}.get(analysis.get('reason'), 'provider unavailable or invalid response')
            blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': 'AI explanation unavailable (' + reason + '). Original results and evidence are unchanged.'}]})
    if context.get('E2E_REPORT_PUBLISHER') == 'true' and context.get('E2E_REPORT_PUBLISH_STATUS') != 'success' and not schedule_monitor and not admission_blocked:
        if publication:
            message = 'Report deployed; live verification is pending. The report link may need a few minutes. Test results above are unchanged.'
        else:
            message = 'Report publishing or verification failed. Use GitHub run artifacts for screenshots, videos and the saved report. Test results above are unchanged.'
        blocks.append({'type': 'section', 'text': {'type': 'mrkdwn', 'text': '*Report delivery*\n' + message}})
    if issues:
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": ("*Schedule issues*\n" if schedule_monitor or admission_blocked else "*Run issues*\n") + "\n".join("• " + clean(issue, 400 if schedule_monitor else 220) for issue in issues[:5])}})
    timing = []
    try:
        start = datetime.fromisoformat(summary["startedAt"].replace("Z", "+00:00"))
        finish = datetime.fromisoformat(summary["finishedAt"].replace("Z", "+00:00"))
        seconds = max(0, int((finish - start).total_seconds()))
        timing = [f"Duration {seconds // 60}m {seconds % 60}s", finish.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime("%d %b %Y · %I:%M %p IST")]
    except (KeyError, ValueError, TypeError):
        pass
    if schedule_monitor:
        checked = datetime.fromisoformat(summary['checkedAt'].replace('Z', '+00:00'))
        timing.append(checked.astimezone(timezone(timedelta(hours=5, minutes=30))).strftime('Checked %d %b %Y · %I:%M %p IST'))
    branch = context.get("GITHUB_REF_NAME", "")
    sha = context.get("GITHUB_SHA", "")[:7]
    if branch:
        timing.append(clean(branch, 80) + (f" · {clean(sha, 7)}" if sha else ""))
    if timing:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": " | ".join(timing)}]})
    buttons = []
    if publication:
        buttons.append({'type': 'button', 'text': {'type': 'plain_text', 'text': 'Open full report' if publication['verified'] else 'Open report (verification pending)'}, 'url': publication['url']})
        if publication['verified'] and (failures or publication['failures']):
            buttons.append({'type': 'button', 'text': {'type': 'plain_text', 'text': 'View failed cases'}, 'url': publication['failedUrl']})
    if url:
        buttons.append({"type": "button", "text": {"type": "plain_text", "text": "Admission details" if admission_blocked else "Monitor details" if schedule_monitor else "GitHub run" if publication else "Run & evidence"}, "url": url})
    origin = http_url(summary.get("origin", context.get("BASE_URL", "")))
    artifact_run = context.get('E2E_REPORT_ARTIFACT_RUN_ID', '')
    if not admission_blocked and context.get('E2E_REPORT_ARTIFACT_STATUS') == 'success' and re.fullmatch(r'[\w.-]+/[\w.-]+', repository) and artifact_run.isdigit():
        buttons.append({'type': 'button', 'text': {'type': 'plain_text', 'text': 'Saved report & media'}, 'url': f'https://github.com/{repository}/actions/runs/{artifact_run}#artifacts'})
    if origin and not publication and not admission_blocked:
        buttons.append({"type": "button", "text": {"type": "plain_text", "text": "Open test store"}, "url": origin})
    if buttons:
        blocks.append({"type": "actions", "elements": buttons})
    if publication and publication['verified']:
        blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': f"Screenshots and videos in the report · Evidence retained for {publication['retentionDays']} days"}]})
    # Fallback is for screen readers and notification previews; only blocks render in-channel.
    fallback = clean(heading) + " — " + detail
    if failures:
        fallback += '. Failures: ' + '; '.join(clean(item.get('title'), 120) for item in failures[:3])
    if publication:
        fallback += '. Report: ' + publication['url']
    return {"text": fallback, "blocks": blocks, "unfurl_links": False, "unfurl_media": False}


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
    try:
        context = source_context(os.environ)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    destination = sys.argv[1] if len(sys.argv) > 1 else "test-results/summary.json"
    try:
        with open(destination, encoding="utf-8") as source:
            summary = validate_summary(json.load(source))
    except (OSError, ValueError):
        summary = {"status": "infrastructure-failed", "error": "No valid run report; inspect configuration, install, runner, or cancellation steps"}
    if context.get("GITHUB_RUN_ID") and str(summary.get('githubRunId', '')) != context['GITHUB_RUN_ID'] and not str(summary.get("runId", "")).startswith(context["GITHUB_RUN_ID"] + "-"):
        summary = {"status": "infrastructure-failed", "error": "Report is missing or belongs to another run; open workflow evidence"}
    if context.get("E2E_JOB_STATUS") in ("failure", "cancelled", "timed_out") and summary.get("status") == "passed":
        summary = dict(summary, status="infrastructure-failed", error="Workflow infrastructure failed after tests")
    if context.get('E2E_EXECUTION_BLOCKED') == 'true':
        rejected = context.get('E2E_ADMISSION_REJECTED') == 'true'
        reason = {'invalid-slot': 'Requested time is outside the active workflow schedule.', 'invalid-overrides': 'Scheduled execution attempted to override its allowed suite or target.', 'future-slot': 'Requested scheduled time is in the future.', 'identity-mismatch': 'Source workflow identity or main-branch validation failed.', 'github-api': 'GitHub rejected a scheduler ownership request.'}.get(context.get('E2E_ADMISSION_REASON'), 'Inspect the source workflow admission job for the rejection reason.')
        # Unverified/admission-rejected execution cannot inherit test counts,
        # AI assessments, report media or results from an unrelated summary.
        summary = {'status': 'infrastructure-failed', 'error': 'Scheduled execution could not be admitted: ' + reason if rejected else 'Execution admission could not be verified; inspect the source workflow receipt and admission job.'}
    try:
        payload = build_payload(summary, context)
    except (OSError, ValueError, KeyError):
        context = dict(context, E2E_REPORT_PUBLISH_STATUS='failure', E2E_REPORT_VERIFY_STATUS='invalid')
        payload = build_payload(summary, context)
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
