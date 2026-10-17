// Disposable browser + client fixture. Never reads a credential or persists a DB.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const ADMIN = 'oauth-browser-fixture-admin';
const PASSWORD = 'oauth-browser-fixture-password';
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(24).toString('hex');
let mf, client, authorizationUrl, tokens, connected = false;
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, origin).pathname;
    if (path === '/fixture/config') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ authorization_url: authorizationUrl, email: 'browser@example.invalid', password: PASSWORD })); return;
    }
    if (path === '/fixture/callback') {
      const query = new URL(req.url, origin).searchParams;
      assert.equal(query.get('state'), state);
      assert.equal(query.get('iss'), origin);
      tokens = await exchange({ grant_type: 'authorization_code', code: query.get('code'), redirect_uri: origin + '/fixture/callback', code_verifier: verifier });
      const put = await rpc('memory_put', { key: 'browser/item', value: 'browser fixture memory', description: 'local browser check' });
      assert.equal(put.isError, undefined);
      const read = await rpc('memory_get', { key: 'browser/item' });
      assert.match(JSON.stringify(read), /browser fixture memory/);
      tokens = await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      await rpc('memory_list', {});
      connected = true;
      res.setHeader('Content-Type','text/html');
      res.setHeader('Cache-Control','no-store');
      res.setHeader('Referrer-Policy','no-referrer');
      res.end('<!doctype html><title>Local OAuth check</title><script>history.replaceState(null,"","/fixture/callback")</script><p>Local OAuth, MCP and refresh passed.</p>'); return;
    }
    if (path === '/fixture/check-revoked') {
      assert.equal(connected, true);
      const access = await fetch(origin + '/mcp', { method:'POST', headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'}) });
      assert.equal(access.status,401);
      const refresh = await tokenResponse({grant_type:'refresh_token',refresh_token:tokens.refresh_token});
      assert.equal(refresh.status,400);
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({revoked_access:true,revoked_refresh:true})); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await mf.dispatchFetch(origin + req.url, { method:req.method, headers:req.headers, body:chunks.length ? Buffer.concat(chunks) : undefined, redirect:'manual' });
    res.statusCode = response.status;
    for (const [key,value] of response.headers) res.setHeader(key,value);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    // Deliberately suppress exceptions: assertion operands may contain credentials.
    res.statusCode=500; res.end('Local fixture check failed');
  }
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
mf = new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,scriptPath:new URL('../dist/index.js',import.meta.url).pathname,compatibilityDate:'2026-10-01',bindings:{API_KEY:ADMIN,OAUTH_ISSUER:origin},d1Databases:['DB'],outboundService:()=>new Response('External network disabled',{status:403})}));
const db = await mf.getD1Database('DB');
const migrations = new URL('../migrations/',import.meta.url);
for (const name of (await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort()) {
  for (const sql of (await readFile(new URL(name,migrations),'utf8')).split('-- statement-breakpoint').filter(s=>s.trim())) await db.prepare(sql).run();
}
async function jsonRequest(path, body, extra={}) {
  return fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...extra},body:JSON.stringify(body)});
}
const created = await jsonRequest('/admin/accounts',{email:'browser@example.invalid',password:PASSWORD,display_name:'Browser fixture'},{'X-Api-Key':ADMIN});
assert.equal(created.status,201);
const login = await jsonRequest('/auth/login',{email:'browser@example.invalid',password:PASSWORD});
assert.equal(login.status,200);
const cookie = login.headers.get('set-cookie').split(';')[0];
for (const name of ['Browser Alpha','Browser Beta']) {
  const response=await jsonRequest('/account/spaces',{display_name:name,memory_type:'general'},{Cookie:cookie}); assert.equal(response.status,201);
}
const registration = await jsonRequest('/oauth/register',{client_name:'Browser test client',redirect_uris:[origin+'/fixture/callback'],token_endpoint_auth_method:'none'});
assert.equal(registration.status,201); client=await registration.json();
const query=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:origin+'/fixture/callback',resource:origin+'/mcp',scope:'memory:read memory:write',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
authorizationUrl=origin+'/oauth/authorize?'+query;
function tokenResponse(params) {
  return fetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,resource:origin+'/mcp',...params})});
}
async function exchange(params) {const response=await tokenResponse(params);assert.equal(response.status,200);return response.json();}
async function rpc(name,args) {
  const response=await fetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  assert.equal(response.status,200);
  const text=await response.text();
  const body=response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6)) : JSON.parse(text);
  assert.equal(body.error,undefined);return body.result;
}
console.log('Disposable OAuth browser fixture: '+origin);
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await mf.dispose();server.close();process.exit(0);});
