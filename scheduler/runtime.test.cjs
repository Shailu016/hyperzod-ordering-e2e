// Exercise the bundled production code in workerd, with all outbound I/O mocked.
// No real credentials, GitHub calls, storefront traffic or notifications.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, verify } = require('node:crypto');
const { build } = require('esbuild');
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');

test('production scheduler transport and authentication work in the Workers runtime', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    SCHEDULER_ENABLED: 'true', SCHEDULER_ENABLED_AT: '2026-10-16T00:00:00.000Z',
    GITHUB_REPOSITORY: 'Owner/Repo', GITHUB_APP_ID: '123', GITHUB_INSTALLATION_ID: '456', GITHUB_REPOSITORY_ID: '789',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  const { outputFiles } = await build({
    stdin: { contents: `import { tick } from './worker.mjs';
      export default { async fetch(_request, env) {
        try { return Response.json(await tick(env, { now: new Date('2026-10-16T07:35:00Z') })); }
        catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
      } };`, resolveDir: __dirname },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  for (const scenario of ['missing', 'already-queued', 'auth-redirect', 'api-redirect']) {
    await t.test(scenario, async () => {
      const calls = [];
      const mf = new Miniflare(convertV4MiniflareOptions({
        modules: true, script: outputFiles[0].text, compatibilityDate: '2026-10-15',
        cf: false, log: new Log(LogLevel.NONE), bindings: env,
        outboundService: async (request) => {
          const url = new URL(request.url);
          assert.equal(url.origin, 'https://api.github.com', 'credentials must never follow a redirect');
          const route = url.pathname;
          calls.push({ route, method: request.method });
          if (route === '/app/installations/456/access_tokens') {
            const [header, payload, signature] = request.headers.get('Authorization').slice(7).split('.');
            assert.ok(verify('RSA-SHA256', Buffer.from(header + '.' + payload), publicKey, Buffer.from(signature, 'base64url')));
            assert.deepEqual(await request.json(), { repository_ids: [789], permissions: { actions: 'write', contents: 'read' } });
            if (scenario === 'auth-redirect') return new Response(null, { status: 302, headers: { Location: 'https://forbidden.invalid/key' } });
            return Response.json({ token: 'fixture-only-installation-token', expires_at: '2026-10-16T08:35:00Z' });
          }
          assert.equal(request.headers.get('Authorization'), 'Bearer fixture-only-installation-token');
          if (scenario === 'api-redirect') return new Response(null, { status: 307, headers: { Location: 'https://forbidden.invalid/token' } });
          if (route.includes('/contents/')) return Response.json({ content: Buffer.from('env:\n  E2E_SCHEDULE_PROTOCOL: slots-v1\n').toString('base64') });
          if (route.endsWith('/runs')) return Response.json({ workflow_runs: scenario === 'already-queued' ? [{
            event: 'workflow_dispatch', head_branch: 'main', display_title: 'Ordering smoke · slot 2026-10-16T07:30:00.000Z', status: 'queued',
          }] : [] });
          if (route.includes('/git/ref/')) return new Response(null, { status: 404 });
          if (route.endsWith('/dispatches')) {
            assert.equal(route, '/repos/Owner/Repo/actions/workflows/scheduled-e2e-smoke.yml/dispatches');
            assert.deepEqual(await request.json(), { ref: 'main', inputs: { suite: 'smoke', schedule_slot: '2026-10-16T07:30:00.000Z' } });
            return new Response(null, { status: 204 });
          }
          throw new Error('Unexpected runtime request: ' + route);
        },
      }));
      try {
        const response = await mf.dispatchFetch('https://fixture.invalid/');
        const result = await response.json();
        assert.equal(response.status, scenario.endsWith('redirect') ? 500 : 200, JSON.stringify(result));
        assert.equal(calls.filter((call) => call.route.endsWith('/dispatches')).length, scenario === 'missing' ? 1 : 0);
        if (scenario.endsWith('redirect')) assert.match(result.error, /HTTP 30[27]/);
        else assert.equal(result.dispatched.length, scenario === 'missing' ? 1 : 0);
      } finally { await mf.dispose(); }
    });
  }
});
