// Synthetic local account/credentials/DB only. Public credentials are never read.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {build} from '../apps/workbench/node_modules/esbuild/lib/main.js';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const hostBundle=await build({entryPoints:[new URL('./workbench-host.js',import.meta.url).pathname],bundle:true,write:false,format:'iife',target:'es2022',nodePaths:[new URL('../apps/workbench/node_modules',import.meta.url).pathname]});
let mf,tokens,initial,accessExpiresAt=0,refreshing;
let rpcId=0;
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,origin).pathname;
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
 if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset=utf-8><title>Walle Memory · 本地预览</title><style>body{margin:0;background:#f4f6fb}iframe{display:block;border:0;width:100%;height:100vh}</style><iframe title="Walle Memory MCP App" sandbox="allow-scripts"></iframe><script src=/fixture/host.js></script>');return;}
 if(path==='/favicon.ico'){res.statusCode=204;res.end();return;}
 if(path==='/fixture/host.js'){res.setHeader('Content-Type','text/javascript');res.end(hostBundle.outputFiles[0].text);return;}
 if(path==='/fixture/app'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(initial.html);return;}
 if(path==='/fixture/tool'&&req.method==='POST'){
  if(req.headers.origin!==origin){res.statusCode=403;res.end();return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if(!['memory_workbench','memory_get','memory_update'].includes(body.name)){res.statusCode=403;res.end();return;}
  const result=await rpc('tools/call',{name:body.name,arguments:body.arguments??{}});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
 }
 if(path==='/fixture/consent'){res.statusCode=302;res.setHeader('Location',initial.authorizationUrl);res.end();return;}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const response=await mf.dispatchFetch(origin+req.url,{method:req.method,headers:req.headers,body:chunks.length?Buffer.concat(chunks):undefined,redirect:'manual'});
 res.statusCode=response.status;for(const [k,v]of response.headers)res.setHeader(k,v);res.end(Buffer.from(await response.arrayBuffer()));
}catch{res.statusCode=500;res.end('Local preview failed');}});
await new Promise(resolve=>server.listen(Number(process.env.WALLE_WORKBENCH_PREVIEW_PORT??0),'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
mf=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,scriptPath:new URL('../dist/index.js',import.meta.url).pathname,compatibilityDate:'2026-10-01',d1Databases:['DB'],bindings:{API_KEY:'synthetic-workbench-admin',OAUTH_ISSUER:origin},outboundService:()=>new Response('External network disabled',{status:403})}));
const db=await mf.getD1Database('DB');
for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort())for(const sql of(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8')).split('-- statement-breakpoint').filter(s=>s.trim()))await db.prepare(sql).run();
async function request(path,body,cookie,admin=false){const r=await mf.dispatchFetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(admin?{'X-Api-Key':'synthetic-workbench-admin'}:{})},body:JSON.stringify(body)});assert.ok(r.ok);return r;}
const email='workbench-preview@example.invalid',password='synthetic-local-preview-only-2026';
await request('/admin/accounts',{email,password,display_name:'工作台预览'},undefined,true);
const login=await request('/auth/login',{email,password});const cookie=login.headers.get('set-cookie').split(';')[0];
const first=(await(await request('/account/spaces',{display_name:'日常工作 · 快照预览',memory_type:'daily-work'},cookie)).json()).space;
const second=(await(await request('/account/spaces',{display_name:'项目空间 · 切换演示',memory_type:'project'},cookie)).json()).space;
const client=await(await request('/oauth/register',{client_name:'Walle Memory 本地预览',redirect_uris:['https://client.example.invalid/callback'],token_endpoint_auth_method:'none'})).json();
const verifier=randomBytes(32).toString('base64url');
const params=new URLSearchParams({client_id:client.client_id,response_type:'code',redirect_uri:client.redirect_uris[0],resource:origin+'/mcp',scope:'memory:read memory:write',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
const context=await(await mf.dispatchFetch(origin+'/oauth/authorize/context?'+params,{headers:{Cookie:cookie,Origin:origin}})).json();
const decision=await(await request('/oauth/authorize',{request_id:context.request_id,csrf_token:context.csrf_token,space_ids:[first.id,second.id],default_space_id:first.id,approve:true},cookie)).json();
const exchange=await mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],resource:origin+'/mcp',code:new URL(decision.redirect_to).searchParams.get('code'),code_verifier:verifier})});assert.equal(exchange.status,200);tokens=await exchange.json();accessExpiresAt=Date.now()+tokens.expires_in*1000-30000;
async function accessToken(){
 if(Date.now()<accessExpiresAt)return tokens.access_token;
 if(!refreshing)refreshing=(async()=>{const response=await mf.dispatchFetch(origin+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,resource:origin+'/mcp',refresh_token:tokens.refresh_token})});assert.equal(response.status,200);tokens=await response.json();accessExpiresAt=Date.now()+tokens.expires_in*1000-30000;return tokens.access_token;})().finally(()=>{refreshing=null;});
 return refreshing;
}
async function rpc(method,params){const token=await accessToken();const r=await mf.dispatchFetch(origin+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});assert.equal(r.status,200);const text=await r.text();const data=r.headers.get('content-type')?.includes('text/event-stream')?JSON.parse(text.split('\n').find(s=>s.startsWith('data: ')).slice(6)):JSON.parse(text);assert.equal(data.error,undefined);return data.result;}
let snapshot;try{snapshot=JSON.parse(await readFile('/private/tmp/walle-workbench-preview-data.json','utf8'));}catch{snapshot={entries:[{key:'tasks/example',description:'待办：整理本周工作',updated_at:Date.now()}],full:{}};}
for(const entry of snapshot.entries){await rpc('tools/call',{name:'memory_put',arguments:{workspace_id:first.id,key:entry.key,description:entry.description,value:snapshot.full[entry.key]?.value??JSON.stringify({preview_note:'本地预览只提供已读取摘要；正式工作台会按需读取完整正文。',description:entry.description})}});await db.prepare('UPDATE memory SET updated_at=? WHERE tenant_id=? AND key=?').bind(entry.updated_at,first.id,entry.key).run();}
await rpc('tools/call',{name:'memory_put',arguments:{workspace_id:second.id,key:'project/example/goal',description:'项目空间示例：工作台验收',value:'这是独立的本地测试 workspace，用于验证空间切换和隔离。'}});
// Change events here are synthetic local seeding events, documented as a local snapshot in the design and validation notes.
const resource=await rpc('resources/read',{uri:'ui://walle-memory/workbench-v1.html'});
initial={html:resource.contents[0].text,authorizationUrl:origin+'/oauth/authorize?'+params};
console.log('Walle Memory preview: '+origin);
console.log('Synthetic login for consent test: workbench-preview@example.invalid');
for(const signal of['SIGINT','SIGTERM'])process.once(signal,async()=>{await mf.dispose();server.close();process.exit(0);});
