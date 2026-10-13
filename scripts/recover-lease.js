const { inspectLease, recoverLease } = require('../utils/lease-recovery');
async function main(args = process.argv.slice(2)) {
  const values = {};
  const flags = new Set(['--recover', '--owner-inactive', '--resources-reconciled']);
  const valued = new Set(['--ref', '--expected-sha', '--expected-owner', '--reason', '--evidence']);
  for (let i = 0; i < args.length; i++) {
    if (flags.has(args[i])) values[args[i]] = true;
    else if (valued.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) { const name = args[i]; values[name] = args[++i]; }
    else throw new Error(`Unknown or incomplete recovery argument: ${args[i]}`);
  }
  const options = { ref: values['--ref'] };
  const result = values['--recover'] ? await recoverLease({ ...options, expectedSha: values['--expected-sha'], expectedOwner: values['--expected-owner'], ownerInactive: values['--owner-inactive'], resourcesReconciled: values['--resources-reconciled'], reason: values['--reason'], evidence: values['--evidence'] }) : await inspectLease(options);
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
