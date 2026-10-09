"""Render example Slack blocks locally. This script never imports or calls delivery."""
import html
import importlib.util
import json
from pathlib import Path
import re
import sys
import os

spec = importlib.util.spec_from_file_location('notifier', Path(__file__).with_name('notify-slack.py'))
notifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notifier)


def markup(value):
    safe = html.escape(html.unescape(value))
    safe = re.sub(r'\*([^*]+)\*', r'<strong>\1</strong>', safe)
    return safe.replace('\n', '<br>')


def render(payload):
    parts = []
    for block in payload['blocks']:
        kind = block['type']
        if kind == 'header':
            parts.append('<h2>' + html.escape(block['text']['text']) + '</h2>')
        elif kind == 'section':
            parts.append('<p>' + markup(block['text']['text']) + '</p>')
        elif kind == 'context':
            parts.append('<small>' + ' | '.join(markup(element['text']) for element in block['elements']) + '</small>')
        elif kind == 'actions':
            parts.append('<div class="actions">' + ''.join('<a href="' + html.escape(button['url'], quote=True) + '">' + html.escape(button['text']['text']) + '</a>' for button in block['elements']) + '</div>')
    return '<article>' + ''.join(parts) + '</article>'


def main():
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('test-results/slack-preview.html')
    if len(sys.argv) > 2:
        summaries = [json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))]
    else:
        summaries = [
            {'suite': 'full', 'status': 'passed', 'counts': {'passed': 96, 'skipped': 3},
             'startedAt': '2026-10-09T04:30:00Z', 'finishedAt': '2026-10-09T04:48:10Z',
             'projects': [{'project': project, 'status': 'passed', 'counts': {'passed': 32, 'skipped': 1}, 'warnings': 2, 'critical': {'signup': 'passed', 'cod': 'passed', 'cleanup': 'passed'}} for project in ['web', 'android', 'ios']]},
            {'suite': 'smoke', 'status': 'failed', 'counts': {'passed': 17, 'failed': 1},
             'failedTests': [{'project': 'web', 'title': 'COD order appears in history', 'error': 'Expected the created order card; see screenshot and request evidence.'}]},
            {'suite': 'smoke', 'status': 'infrastructure-failed', 'error': 'Another runner owns this test account; inspect the lease before recovering it.'},
        ]
    context = {'GITHUB_REPOSITORY': 'Shailu016/hyperzod-ordering-e2e', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_NUMBER': '21', 'BASE_URL': 'https://automations-store.hyperzod.me'}
    if len(sys.argv) > 2:
        context = {'GITHUB_REPOSITORY': 'Shailu016/hyperzod-ordering-e2e', 'GITHUB_RUN_ID': str(summaries[0].get('githubRunId') or ''), 'GITHUB_RUN_NUMBER': os.environ.get('GITHUB_RUN_NUMBER', ''), 'BASE_URL': summaries[0].get('origin', '')}
    cards = ''.join(render(notifier.build_payload(summary, context)) for summary in summaries)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ordering report preview</title>
<style>body{background:#f4f5f7;color:#1d1c1d;font:15px/1.5 system-ui,sans-serif;margin:0;padding:32px}main{max-width:780px;margin:auto}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:0}article{background:white;border:1px solid #e0e1e5;border-radius:12px;margin:22px 0;padding:22px}p{margin:16px 0}small{display:block;color:#616061;margin:14px 0}.actions{display:flex;gap:10px;margin-top:18px}a{border:1px solid #c7cacd;border-radius:6px;padding:6px 12px;text-decoration:none;color:#1264a3;font-weight:600}.note{color:#616061;margin:0 0 24px}</style>
<main><h1>Ordering automation · Slack report</h1><p class="note">Local layout preview. Example data unless a run summary was provided. No Slack messages sent.</p>''' + cards + '</main></html>', encoding='utf-8')
    print(str(output.resolve()))


if __name__ == '__main__':
    main()
