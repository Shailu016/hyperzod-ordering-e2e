"""Confirm this source attempt is live before advertising public evidence links."""
import argparse
import json
import re
import time
import urllib.request
from pathlib import Path
from urllib.parse import urljoin, urlparse


def verify(base_url, publication, opener=urllib.request.urlopen, wait=time.sleep):
    parsed = urlparse(base_url)
    key = publication.get('runKey', '')
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or not re.fullmatch(r'\d+-[1-9]\d*', key):
        raise ValueError('Invalid published report destination')
    url = urljoin(base_url.rstrip('/') + '/', 'runs/' + key + '/manifest.json')
    for attempt in range(3):
        try:
            with opener(urllib.request.Request(url, headers={'Cache-Control': 'no-cache'}), timeout=20) as response:
                live = json.loads(response.read(1024 * 1024))
            if any(live.get(field) != publication.get(field) for field in ('runKey', 'sourceRunId', 'sourceAttempt', 'sourceSha', 'finishedAt')):
                raise ValueError('Published evidence belongs to another run or attempt')
            return
        except (OSError, ValueError):
            if attempt == 2:
                raise RuntimeError('The deployed report could not be verified; do not advertise evidence links') from None
            wait(5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--publication', required=True)
    args = parser.parse_args()
    verify(args.base_url, json.loads(Path(args.publication).read_text(encoding='utf-8')))


if __name__ == '__main__':
    main()
