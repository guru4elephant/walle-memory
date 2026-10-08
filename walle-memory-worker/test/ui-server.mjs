// Disposable UI fixture. No persistence, Cloudflare config or external requests.
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Opt in only inside this disposable fixture:
// WALLE_UI_REGISTRATION_MODE=invite node test/ui-server.mjs
const registrationMode = process.env.WALLE_UI_REGISTRATION_MODE === 'invite' ? 'invite' : 'admin';
const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false, modules: true, host: '127.0.0.1', port: 0,
  scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
  compatibilityDate: '2026-10-01',
  bindings: { API_KEY: 'local-ui-test-admin', REGISTRATION_MODE: registrationMode }, d1Databases: ['DB'],
  outboundService: () => new Response('External network disabled', { status: 403 }),
}));
const db = await mf.getD1Database('DB');
const migrations = new URL('../migrations/', import.meta.url);
for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
  const source = await readFile(new URL(file, migrations), 'utf8');
  for (const statement of source.split('-- statement-breakpoint').filter(s => s.trim())) {
    await db.prepare(statement.trim()).run();
  }
}
const legacy = await mf.dispatchFetch('http://localhost/admin/tenants', {
  method: 'POST', headers: { 'X-Api-Key': 'local-ui-test-admin', 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Legacy test memories' }),
});
if (legacy.status !== 201) throw new Error('UI fixture initialization failed');
// Discard the one-time legacy credential without printing or persisting it.
await legacy.body.cancel();
console.log('Disposable UI fixture (' + registrationMode + '): ' + (await mf.ready).origin + '/account');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await mf.dispose(); process.exit(0);
});
