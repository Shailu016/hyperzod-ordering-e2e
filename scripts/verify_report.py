"""Verify the exact published attempt, allowing bounded Pages propagation delays."""
import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urljoin, urlparse

RETRY_DELAYS = (5, 10, 20, 30, 45, 60)
MAX_MANIFEST_BYTES = 1024 * 1024


class VerificationError(RuntimeError):
    def __init__(self, status, reason):
        self.status = status
        self.reason = reason
        super().__init__('Report verification ' + status + ': ' + reason)


def verify(base_url, publication, opener=urllib.request.urlopen, wait=time.sleep, log=print):
    parsed = urlparse(base_url)
    key = publication.get('runKey', '')
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or not re.fullmatch(r'\d+-[1-9]\d*', key):
        raise ValueError('Invalid published report destination')
    url = urljoin(base_url.rstrip('/') + '/', 'runs/' + key + '/manifest.json')
    for attempt in range(len(RETRY_DELAYS) + 1):
        status, reason = 'pending', 'Network request did not complete'
        try:
            # A new query avoids reusing an edge-cached 404 from the first probe.
            request = urllib.request.Request(url + '?verification=' + str(time.time_ns()) + '-' + str(attempt), headers={'Cache-Control': 'no-cache', 'Accept': 'application/json'})
            with opener(request, timeout=15) as response:
                raw = response.read(MAX_MANIFEST_BYTES + 1)
            if len(raw) > MAX_MANIFEST_BYTES:
                raise VerificationError('invalid', 'Manifest exceeds the verification size limit')
            live = json.loads(raw)
            fields = ('runKey', 'sourceRunId', 'sourceAttempt', 'sourceSha', 'finishedAt')
            if not isinstance(live, dict) or any(live.get(field) != publication.get(field) for field in fields):
                raise VerificationError('invalid', 'Published evidence belongs to another run, attempt or revision')
            log('Report verified for source attempt ' + key)
            return
        except VerificationError:
            raise
        except urllib.error.HTTPError as error:
            reason = 'HTTP ' + str(error.code)
            if error.code == 429:
                raise VerificationError('pending', reason + '; server rate limit prevents further probes') from None
            if error.code not in (404, 408, 500, 502, 503, 504):
                raise VerificationError('invalid', reason) from None
        except (UnicodeError, ValueError):
            raise VerificationError('invalid', 'Response is not a valid report manifest') from None
        except OSError:
            # Never echo exception bodies, headers or authenticated request data.
            reason = 'Network or timeout error'
        if attempt == len(RETRY_DELAYS):
            raise VerificationError(status, reason + '; verification retry budget exhausted') from None
        delay = RETRY_DELAYS[attempt]
        log('Report verification attempt ' + str(attempt + 1) + '/7: ' + reason + '; retrying in ' + str(delay) + 's')
        wait(delay)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--publication', required=True)
    args = parser.parse_args()
    status = 'invalid'
    try:
        verify(args.base_url, json.loads(Path(args.publication).read_text(encoding='utf-8')))
        status = 'verified'
        return 0
    except VerificationError as error:
        status = error.status
        print(str(error))
        return 1
    finally:
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                output.write('status=' + status + '\n')


if __name__ == '__main__':
    raise SystemExit(main())
