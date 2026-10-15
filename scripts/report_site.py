"""Build portable public report bundles. Never copies the raw result/auth directory."""
import argparse
import hashlib
import html
import importlib.util
import json
import os
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEVICES = {'web': 'Desktop Chrome', 'android': 'Android', 'ios': 'iOS', 'setup': 'Signup'}
MAX_SITE_BYTES = 850 * 1024 * 1024
MAX_BUNDLE_BYTES = 250 * 1024 * 1024
ALLOWED = {'.html', '.js', '.css', '.json', '.txt', '.md', '.log', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webm', '.mp4', '.woff', '.woff2'}
CSS = '''*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#18243a;font:15px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:35px 24px 70px}h1{font-size:30px;line-height:1.2}h2{font-size:20px}.muted{color:#627087}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}.card,details,.notice{background:white;border:1px solid #dce2eb;border-radius:10px;padding:20px;margin:14px 0}a{color:#195bc5}nav{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.button{display:inline-block;text-decoration:none;background:#edf3ff;border:1px solid #bed0ed;border-radius:6px;padding:8px 13px}.failed,.infrastructure-failed{color:#af2435}.passed{color:#156339}.counts{font-size:19px;font-weight:650}.badge{font-weight:700}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f4f8;padding:15px;font:13px/1.6 monospace}img,video{display:block;max-width:100%;max-height:720px;margin:14px auto;background:#eee}summary{cursor:pointer;font-weight:600}.small{font-size:13px}.notice{border-left:4px solid #d79e20}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #ddd}code{overflow-wrap:anywhere}'''


def utc(value):
    result = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Report timestamps require a timezone')
    return result.astimezone(timezone.utc)


def iso(value):
    return value.isoformat().replace('+00:00', 'Z')


def esc(value):
    return html.escape(str(value if value is not None else ''), quote=True)


def ist(value):
    return utc(value).astimezone(timezone(timedelta(hours=5, minutes=30))).strftime('%d %b %Y, %I:%M %p IST')


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def page(title, body):
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>' + esc(title) + '</title><style>' + CSS + '</style></head><body><main>' + body + '</main></body></html>'


def inside(root, candidate):
    root, candidate = Path(root).resolve(), Path(candidate).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError('Evidence path escapes its report directory')
    return candidate


def copy_native(source, destination):
    if source.is_symlink():
        raise ValueError('Report symlinks cannot be published')
    if not (source / 'index.html').is_file():
        raise ValueError('Native HTML report is missing')
    for entry in source.rglob('*'):
        if entry.is_symlink():
            raise ValueError('Report symlinks cannot be published')
        if not entry.is_file():
            continue
        if entry.suffix.lower() not in ALLOWED or entry.name.startswith('.'):
            raise ValueError('Unsupported public report file (' + entry.suffix + '); traces and private state must stay in GitHub artifacts')
        target = destination / entry.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(entry, target)


def attachment_file(project_dir, value):
    normalized = str(value).replace('\\', '/')
    if '/artifacts/' in normalized:
        candidate = project_dir / 'artifacts' / normalized.split('/artifacts/', 1)[1]
    elif normalized.startswith('artifacts/') or normalized.startswith('html/'):
        candidate = project_dir / normalized
    else:
        candidate = Path(normalized)
        if not candidate.is_absolute():
            candidate = project_dir / normalized
    return inside(project_dir, candidate)


def cases(suites, parents=()):
    for suite in suites:
        ancestors = (*parents, suite.get('title', ''))
        for spec in suite.get('specs', []):
            for test in spec.get('tests', []):
                yield spec, test, ancestors
        yield from cases(suite.get('suites', []), ancestors)


def prepare(input_dir, output_dir, source, now=None):
    now = now or datetime.now(timezone.utc)
    input_dir, output_dir = Path(input_dir).resolve(), Path(output_dir).resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError('Prepared output must be a fresh directory')
    run_id, attempt = str(source['id']), str(source.get('run_attempt', 1))
    if not run_id.isdigit() or not attempt.isdigit() or int(attempt) < 1:
        raise ValueError('Invalid source run identity')
    identity = read_json(input_dir / 'source.json')
    if any(str(identity.get(field, '')) != str(source.get(field, '')) for field in ('id', 'run_attempt', 'head_sha')):
        raise ValueError('Evidence belongs to another source attempt or revision')
    summary = read_json(input_dir / 'summary.json')
    if not str(summary.get('runId', '')).startswith(run_id + '-') or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', summary['runId']):
        raise ValueError('Artifact belongs to another source run')
    if not summary.get('finishedAt') or summary.get('status') not in ('passed', 'failed', 'infrastructure-failed'):
        raise ValueError('A completed run summary is required')
    module_spec = importlib.util.spec_from_file_location('report_notifier', Path(__file__).with_name('notify-slack.py'))
    notifier = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(notifier)
    notifier.validate_summary(summary)
    if source.get('conclusion') in ('failure', 'cancelled', 'timed_out') and summary['status'] == 'passed':
        summary = dict(summary, status='infrastructure-failed', error='Workflow infrastructure failed after tests')
    completed = utc(summary['finishedAt'])
    if completed > now + timedelta(minutes=5):
        raise ValueError('Report completion is in the future')
    days = 3 if summary['status'] == 'passed' else 14
    expires = completed + timedelta(days=days)
    if expires <= now:
        raise ValueError('Source report has already expired')
    run_key = run_id + '-' + attempt
    run_root = output_dir / 'bundle' / 'runs' / run_key
    run_root.mkdir(parents=True)
    details, warnings = [], []
    run_dir = inside(input_dir, input_dir / summary['runId'])
    for project in summary.get('projects', []):
        name = project.get('project')
        if name not in DEVICES:
            raise ValueError('Unknown report device')
        project_dir = run_dir / name
        if not (project_dir / 'report.json').is_file():
            if project.get('status') == 'passed':
                raise ValueError('A passing device is missing its evidence')
            warnings.append(DEVICES[name] + ': report unavailable; inspect the GitHub run')
            continue
        has_native = (project_dir / 'html' / 'index.html').is_file()
        if has_native:
            copy_native(project_dir / 'html', run_root / 'devices' / name)
        elif project.get('status') == 'passed':
            raise ValueError('A passing device is missing its HTML evidence')
        else:
            warnings.append(DEVICES[name] + ': native HTML unavailable; captured failure media is shown below')
        document = read_json(project_dir / 'report.json')
        for spec, test, ancestors in cases(document.get('suites', [])):
            if test.get('status') not in ('unexpected', 'flaky'):
                continue
            identity = json.dumps([name, spec.get('id'), spec.get('file'), ancestors, spec.get('title')], ensure_ascii=False)
            case_id = hashlib.sha256(identity.encode()).hexdigest()[:20]
            recorded = next((item for item in summary.get('failedTests', []) if item.get('project') == name and item.get('title') == spec.get('title')), {})
            error = recorded.get('error') or 'Open the Playwright report for assertion details'
            state = 'flaky' if test['status'] == 'flaky' else 'failed'
            item = {'id': case_id, 'project': name, 'title': spec.get('title', 'Failed scenario'), 'status': state, 'error': error[:6000], 'path': 'failures/' + case_id + '.html'}
            if has_native:
                item['nativePath'] = 'devices/' + name + '/#?q=s:' + state
            for result in reversed(test.get('results', [])):
                for attachment in result.get('attachments', []):
                    kind = 'screenshot' if attachment.get('contentType') in ('image/png', 'image/jpeg') else 'video' if attachment.get('contentType') in ('video/webm', 'video/mp4') else None
                    if not kind or kind in item or not attachment.get('path'):
                        continue
                    original = attachment_file(project_dir, attachment['path'])
                    if not original.is_file():
                        warnings.append(DEVICES[name] + ': a failure attachment is unavailable')
                        continue
                    extension = {'image/png': '.png', 'image/jpeg': '.jpg', 'video/webm': '.webm', 'video/mp4': '.mp4'}[attachment['contentType']]
                    # Playwright already stores content-addressed media in HTML/data.
                    # Reuse it instead of publishing a second copy of each recording.
                    with original.open('rb') as media:
                        digest = hashlib.file_digest(media, 'sha1').hexdigest()
                    native_media = 'devices/' + name + '/data/' + digest + extension
                    if (run_root / native_media).is_file():
                        item[kind] = native_media
                        continue
                    relative = 'evidence/' + case_id + '-' + kind + extension
                    target = run_root / relative
                    target.parent.mkdir(exist_ok=True)
                    shutil.copyfile(original, target)
                    item[kind] = relative
            details.append(item)
    metadata = {key: summary.get(key) for key in ('suite', 'status', 'counts', 'projects', 'origin', 'startedAt', 'finishedAt')}
    # Publish only selected summary fields, not raw reports or runner filesystem paths.
    metadata['projects'] = [{key: item.get(key) for key in ('project', 'status', 'counts', 'critical', 'warnings')} for item in summary.get('projects', [])]
    metadata.update({'schemaVersion': 1, 'runKey': run_key, 'sourceRunId': run_id, 'sourceAttempt': attempt, 'sourceSha': source.get('head_sha', ''), 'runNumber': source.get('run_number', ''), 'sourceUrl': source.get('html_url', ''), 'expiresAt': iso(expires), 'retentionDays': days, 'failures': details, 'warnings': warnings})
    write_json(run_root / 'manifest.json', metadata)
    render_run(run_root, metadata)
    if sum(entry.stat().st_size for entry in run_root.rglob('*') if entry.is_file()) > MAX_BUNDLE_BYTES:
        raise ValueError('This report exceeds the history bundle size budget; use GitHub evidence')
    write_json(output_dir / 'notification.json', summary)
    write_json(output_dir / 'publication.json', metadata)
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf-8') as handle:
            handle.write(f'run_key={run_key}\nretention_days={days}\n')
    return metadata


def count_text(counts):
    return ' · '.join(str(counts.get(key, 0)) + ' ' + label for key, label in [('passed', 'passed'), ('failed', 'failed'), ('skipped', 'skipped'), ('flaky', 'flaky'), ('notRun', 'not run')])


def render_run(root, data):
    title = 'Ordering ' + str(data.get('suite') or 'test run')
    body = '<p class="muted">ORDERING AUTOMATION · RUN EVIDENCE</p><h1>' + esc(title) + '</h1><p class="badge ' + esc(data['status']) + '">' + esc(data['status'].replace('-', ' ').title()) + '</p><p class="counts">' + esc(count_text(data.get('counts') or {})) + '</p>'
    body += '<p>' + esc(ist(data['finishedAt'])) + ' · Source <code>' + esc(data.get('sourceSha', '')[:7]) + '</code> · Run <code>' + esc(data['runKey']) + '</code></p>'
    if data.get('origin'):
        body += '<p class="muted">Target: <code>' + esc(data['origin']) + '</code></p>'
    body += '<p class="muted">Evidence expires ' + esc(ist(data['expiresAt'])) + '. Retention: ' + str(data['retentionDays']) + ' days.</p><nav><a class="button" href="../../">Report history</a><a class="button" href="#failures">Failed / flaky cases</a>'
    if re.fullmatch(r'https://github\.com/[\w.-]+/[\w.-]+/actions/runs/\d+', data.get('sourceUrl', '')):
        body += '<a class="button" href="' + esc(data['sourceUrl']) + '">GitHub run</a>'
    body += '</nav><div class="cards">'
    for project in data.get('projects', []):
        name = project['project']
        body += '<article class="card"><h2>' + esc(DEVICES[name]) + '</h2><p class="badge ' + esc(project['status']) + '">' + esc(project['status']) + '</p><p>' + esc(count_text(project.get('counts') or {})) + '</p>'
        if (root / 'devices' / name / 'index.html').is_file():
            body += '<a class="button" href="devices/' + esc(name) + '/">Open Playwright report</a>'
        body += '</article>'
    body += '</div><h2 id="failures">Failed cases</h2>'
    for item in data['failures']:
        body += '<article class="card"><strong>' + esc(DEVICES[item['project']]) + ' · ' + esc(item['title']) + '</strong><pre>' + esc(item['error'][:1000]) + '</pre><a class="button" href="' + esc(item['path']) + '">Inspect failure</a></article>'
        content = '<p><a href="../index.html#failures">← Failed cases</a></p><h1>' + esc(item['title']) + '</h1><p>' + esc(DEVICES[item['project']]) + ' · ' + esc(ist(data['finishedAt'])) + '</p><pre>' + esc(item['error']) + '</pre>'
        for kind in ('screenshot', 'video'):
            if kind in item:
                src = '../' + item[kind]
                content += '<h2 id="' + kind + '">' + kind.title() + '</h2>'
                if kind == 'screenshot':
                    content += '<a href="' + esc(src) + '"><img alt="Failure screenshot" src="' + esc(src) + '"></a>'
                else:
                    poster = ' poster="../' + esc(item['screenshot']) + '"' if item.get('screenshot') else ''
                    content += '<video controls playsinline preload="metadata"' + poster + ' src="' + esc(src) + '"></video><p><a download href="' + esc(src) + '">Download video</a> · If playback is unavailable in your browser, download the recording.</p>'
        if not item.get('screenshot') and not item.get('video'):
            content += '<p class="notice">No screenshot or video was captured for this failure. Inspect the native report and GitHub evidence.</p>'
        if item.get('nativePath'):
            content += '<nav><a class="button" href="../' + esc(item['nativePath']) + '">Open native failed / flaky cases</a></nav>'
        target = root / item['path']
        target.parent.mkdir(exist_ok=True)
        target.write_text(page(item['title'], content), encoding='utf-8')
    if not data['failures']:
        body += '<p>No failed case details recorded for this run.</p>'
    for warning in data.get('warnings', []):
        body += '<p class="notice">' + esc(warning) + '</p>'
    (root / 'index.html').write_text(page(title, body), encoding='utf-8')


def assemble(bundles, destination, now=None):
    now = now or datetime.now(timezone.utc)
    destination = Path(destination).resolve()
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Site output must be a fresh directory')
    destination.mkdir(parents=True, exist_ok=True)
    reports = {}
    for bundle in bundles:
        for manifest in Path(bundle).glob('runs/*/manifest.json'):
            data = read_json(manifest)
            key = data.get('runKey', '')
            if not re.fullmatch(r'\d+-[1-9]\d*', key) or manifest.parent.name != key or data.get('schemaVersion') != 1:
                raise ValueError('Invalid history bundle identity')
            expected_days = 3 if data.get('status') == 'passed' else 14
            if data.get('retentionDays') != expected_days or utc(data['expiresAt']) != utc(data['finishedAt']) + timedelta(days=expected_days):
                raise ValueError('Invalid history retention metadata')
            if utc(data['expiresAt']) <= now:
                continue
            if key in reports:
                continue
            copy_native(manifest.parent, destination / 'runs' / key)
            reports[key] = data
    total = sum(entry.stat().st_size for entry in destination.rglob('*') if entry.is_file())
    if total > MAX_SITE_BYTES:
        raise ValueError('Retained reports exceed the Pages size budget; reduce retention before publishing')
    records = sorted(reports.values(), key=lambda item: item['finishedAt'], reverse=True)
    body = '<p class="muted">ORDERING AUTOMATION</p><h1>Test reports</h1><p>Desktop, Android and iOS evidence. Failed reports are retained for 14 days; passing reports for 3 days. Expired reports are removed on the next successful publication or daily cleanup.</p>'
    if records:
        body += '<nav><a class="button" href="runs/' + esc(records[0]['runKey']) + '/">Latest report</a></nav>'
    for record in records:
        body += '<article class="card"><a href="runs/' + esc(record['runKey']) + '/"><strong>' + esc(record.get('suite', 'run')) + ' · ' + esc(record['status']) + ' · ' + esc(ist(record['finishedAt'])) + '</strong></a><p>' + esc(count_text(record.get('counts') or {})) + '</p></article>'
    if not records:
        body += '<p>No retained reports are available.</p>'
    (destination / 'index.html').write_text(page('Ordering test reports', body), encoding='utf-8')
    (destination / '.nojekyll').write_text('', encoding='utf-8')
    write_json(destination / 'history.json', [{'runKey': item['runKey'], 'finishedAt': item['finishedAt'], 'expiresAt': item['expiresAt']} for item in records])
    return records


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    build = sub.add_parser('prepare')
    build.add_argument('--input', required=True)
    build.add_argument('--output', required=True)
    build.add_argument('--source', required=True)
    merge = sub.add_parser('assemble')
    merge.add_argument('--bundles', nargs='*', default=[])
    merge.add_argument('--history')
    merge.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.input, args.output, read_json(args.source))
    else:
        history = [str(item) for item in Path(args.history).iterdir() if item.is_dir()] if args.history else []
        assemble([*args.bundles, *history], args.output)


if __name__ == '__main__':
    main()
