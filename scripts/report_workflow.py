"""Stable, allowlisted workflow identities; display titles are never authority."""
WORKFLOWS = {
    '.github/workflows/scheduled-e2e-smoke.yml': ('smoke', 'scheduled-e2e-smoke', 'e2e-smoke-'),
    '.github/workflows/scheduled-e2e.yml': ('full', 'scheduled-e2e-full', 'e2e-results-'),
}


def workflow_identity(source):
    identity = WORKFLOWS.get(source.get('path'))
    workflow_id = source.get('workflow_id')
    if identity is None or type(workflow_id) is not int or workflow_id <= 0:
        raise ValueError('Unknown report source workflow')
    return identity


def verify_workflow(source, definition):
    workflow_identity(source)
    if type(definition.get('id')) is not int or definition['id'] != source['workflow_id'] or definition.get('path') != source['path']:
        raise ValueError('Report source workflow identity mismatch')
