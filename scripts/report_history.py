"""Restore retained report bundles from Actions artifacts, never a Git branch."""
import argparse
import json
import os
import re
import stat
import subprocess
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath

from report_site import utc


def safe_extract(archive, destination):
    destination = Path(destination).resolve()
    with zipfile.ZipFile(archive) as handle:
        entries = handle.infolist()
        if len(entries) > 30_000 or sum(item.file_size for item in entries) > 250 * 1024 * 1024:
            raise ValueError('History bundle exceeds extraction limits')
        for entry in entries:
            parts = PurePosixPath(entry.filename).parts
            if not parts or parts[0] != 'runs' or '..' in parts or '\\' in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Unsafe history archive member')
            target = (destination / entry.filename).resolve()
            if not target.is_relative_to(destination):
                raise ValueError('History archive path escapes destination')
        handle.extractall(destination)


def restore(repository, repository_id, directory, current_key='', run=subprocess.run, now=None):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not str(repository_id).isdigit():
        raise ValueError('Invalid history repository')
    now = now or datetime.now(timezone.utc)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError('History restore destination must be fresh')
    response = run(['gh', 'api', '--paginate', '--slurp', f'repos/{repository}/actions/artifacts?per_page=100'], capture_output=True, check=True)
    pages = json.loads(response.stdout)
    selected = {}
    for item in [item for page in pages for item in page.get('artifacts', [])]:
        match = re.fullmatch(r'ordering-report-(\d+-[1-9]\d*)', item.get('name', ''))
        producer = item.get('workflow_run') or {}
        if not match or item.get('expired') or match[1] == current_key:
            continue
        if producer.get('head_branch') != 'main' or str(producer.get('head_repository_id')) != str(repository_id):
            continue
        if utc(item['created_at']) < now - timedelta(days=14) or not str(item.get('id', '')).isdigit():
            continue
        if item.get('size_in_bytes', 0) > 250 * 1024 * 1024:
            raise ValueError('A retained report exceeds the bundle size budget')
        selected.setdefault(match[1], item)
    for key, item in selected.items():
        archive = directory / (key + '.zip')
        try:
            with archive.open('wb') as output:
                run(['gh', 'api', f'repos/{repository}/actions/artifacts/{item["id"]}/zip'], stdout=output, stderr=subprocess.PIPE, check=True)
            safe_extract(archive, directory / key)
        except subprocess.CalledProcessError as error:
            raise RuntimeError('Report history download failed; preserve the existing Pages deployment') from error
        finally:
            archive.unlink(missing_ok=True)
    return [str(directory / key) for key in selected]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--current-key', default='')
    args = parser.parse_args()
    restore(os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_REPOSITORY_ID'], args.output, args.current_key)


if __name__ == '__main__':
    main()
