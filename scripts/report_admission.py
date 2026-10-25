"""Validate the source run's scheduler receipt before reporting an execution."""
import argparse
import json
import os
import re
from pathlib import Path
from datetime import datetime
from report_workflow import workflow_identity

REASONS = {'invalid-slot', 'invalid-overrides', 'future-slot', 'identity-mismatch', 'github-api', 'unknown'}


def assess(receipt, source):
    kind, _, _ = workflow_identity(source)
    expected = {'protocol': 'slots-v1', 'runId': str(source['id']), 'attempt': str(source['run_attempt']), 'sha': source['head_sha'], 'kind': kind}
    if not isinstance(receipt, dict) or any(receipt.get(key) != value for key, value in expected.items()):
        raise ValueError('Schedule admission belongs to another run, attempt or revision')
    status = receipt.get('status')
    if status not in ('manual', 'claimed', 'duplicate', 'expired', 'error') or type(receipt.get('admitted')) is not bool:
        raise ValueError('Invalid schedule admission status')
    if receipt['admitted'] != (status in ('manual', 'claimed')):
        raise ValueError('Inconsistent schedule admission')
    if status in ('claimed', 'duplicate', 'expired'):
        due = receipt.get('due', '')
        if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z', due):
            raise ValueError('Invalid scheduled-slot timestamp')
        datetime.fromisoformat(due.replace('Z', '+00:00'))
    if status in ('claimed', 'duplicate'):
        if not str(receipt.get('ownerRunId', '')).isdigit() or not re.fullmatch(r'[1-9]\d*', str(receipt.get('ownerAttempt', ''))):
            raise ValueError('Missing scheduled-slot owner')
        owned = receipt['ownerRunId'] == expected['runId'] and receipt['ownerAttempt'] == expected['attempt']
        if owned != (status == 'claimed'):
            raise ValueError('Inconsistent scheduled-slot ownership')
    return {'publish': status not in ('duplicate', 'expired'), 'blocked': status == 'error'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--source', required=True)
    args = parser.parse_args()
    # Invalid/missing receipt is a visible infrastructure failure, never a silent skip.
    result = {'publish': True, 'blocked': True}
    rejected, reason = False, 'receipt-unverified'
    try:
        receipt = json.loads(Path(args.receipt).read_text(encoding='utf-8'))
        result = assess(receipt, json.loads(Path(args.source).read_text(encoding='utf-8')))
        rejected = result['blocked'] and receipt['status'] == 'error'
        reason = receipt.get('reasonCode', 'unknown') if rejected else ''
        if rejected and (not isinstance(reason, str) or reason not in REASONS):
            reason = 'unknown'
    except (OSError, ValueError, KeyError, TypeError):
        print('Scheduled execution admission could not be verified')
        return_code = 1
    else:
        print('Execution receipt: ' + ('publish evidence' if result['publish'] else 'duplicate/expired slot; no test notification'))
        return_code = 0
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf-8') as handle:
            handle.write(''.join(key + '=' + str(value).lower() + '\n' for key, value in result.items()))
            handle.write('rejected=' + str(rejected).lower() + '\nreason=' + reason + '\n')
    return return_code


if __name__ == '__main__':
    raise SystemExit(main())
