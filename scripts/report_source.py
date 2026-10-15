"""Resolve a trusted completed source workflow without executing artifact content."""
import json
import os
import re
import base64
import subprocess
from pathlib import Path


def resolve(event, repository):
    source = event['workflow_run']
    if source.get('head_branch') != 'main' or source.get('head_repository', {}).get('full_name') != repository or source.get('status') != 'completed':
        raise ValueError('Only completed runs from this repository main may publish reports')
    names = {'scheduled-e2e-smoke': 'e2e-smoke-', 'scheduled-e2e-full': 'e2e-results-'}
    if source.get('name') not in names or not all(str(source.get(field, '')).isdigit() for field in ('id', 'run_number', 'run_attempt')):
        raise ValueError('Unknown report source workflow')
    if not re.fullmatch(r'[a-f0-9]{40}', source.get('head_sha', '')):
        raise ValueError('Invalid report source revision')
    metadata = {key: source.get(key) for key in ('id', 'run_number', 'run_attempt', 'head_sha', 'head_branch', 'conclusion', 'name', 'html_url')}
    return metadata, names[source['name']] + str(source['run_number']) + '-attempt-' + str(source['run_attempt'])


def delivery_mode(contents):
    return 'pages-v1' if re.search(r'^\s*REPORT_DELIVERY: pages-v1\s*$', contents, re.MULTILINE) else 'legacy'


def main():
    source, artifact = resolve(json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text()), os.environ['GITHUB_REPOSITORY'])
    # A run that started before the migration still sends its own webhook.
    # Read its trusted workflow revision to avoid sending a second message.
    file = 'scheduled-e2e-smoke.yml' if source['name'] == 'scheduled-e2e-smoke' else 'scheduled-e2e.yml'
    response = subprocess.run(['gh', 'api', f'repos/{os.environ["GITHUB_REPOSITORY"]}/contents/.github/workflows/{file}?ref={source["head_sha"]}'], capture_output=True, check=True)
    contents = base64.b64decode(json.loads(response.stdout)['content']).decode('utf-8')
    delivery = delivery_mode(contents)
    admission = 'slots-v1' if re.search(r'^\s*E2E_SCHEDULE_PROTOCOL: slots-v1\s*$', contents, re.MULTILINE) else 'legacy'
    Path('.report-publication').mkdir(exist_ok=True)
    Path('.report-publication/source-run.json').write_text(json.dumps(source), encoding='utf-8')
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        output.write(f'id={source["id"]}\nattempt={source["run_attempt"]}\nnumber={source["run_number"]}\nsha={source["head_sha"]}\nartifact={artifact}\nconclusion={source["conclusion"]}\ndelivery={delivery}\nadmission={admission}\n')


if __name__ == '__main__':
    main()
