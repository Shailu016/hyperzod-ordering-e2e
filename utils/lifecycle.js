/** Missing cleanup proof or an ambiguous order keeps the identity locked for reconciliation. */
function requiresReconciliation(resource) {
  if (!resource) return true;
  if (resource.submissionAttempted && !resource.orders?.length) return true;
  return !['absent-proven', 'deleted-and-proven'].includes(resource.lifecycle);
}
module.exports = { requiresReconciliation };
