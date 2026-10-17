import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { consumeRateLimit, resolveMemoryAuth } from './accounts';
import { CredentialExpiredError, hashKey, MemoryStore } from './store';
import { MEMORY_INSTRUCTIONS } from './memory-instructions';
import { WORKBENCH_HTML } from './workbench-html';
import { oauthAllowedOrigins, oauthIssuer, oauthResource, resolveOAuthAccess, type OAuthEnv } from './oauth';

type Permission = 'read' | 'write' | 'delete' | 'gc';
type OAuthAccess = NonNullable<Awaited<ReturnType<typeof resolveOAuthAccess>>>;
type Access = Omit<OAuthAccess, 'credential'> & {
  credential: OAuthAccess['credential'] | { kind: 'api-key'; keyHash: string };
};

const WORKBENCH_URI = 'ui://walle-memory/workbench-v1.html';
const WORKBENCH_MIME = 'text/html;profile=mcp-app';
const encoder = new TextEncoder();
const MAX_BODY_BYTES = 1024 * 1024;
const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Vary': 'Origin',
};

function boundedText(maxBytes: number, nonempty = false) {
  return z.string().max(maxBytes)
    .refine(value => !value.includes('\0') && (!nonempty || value.trim().length > 0), 'Invalid text')
    .refine(value => encoder.encode(value).byteLength <= maxBytes, 'Text is too long');
}

const workspaceSchema = boundedText(128,true).optional().describe('此连接已授权的 workspace ID；先用 memory_workspaces 查看。OAuth 限已选择空间，API Key 限绑定的单个空间。省略时使用连接默认空间。');
const keySchema = boundedText(1024, true).describe('记忆的稳定 key，例如 tasks/2026-10-11/topic、user/preferences/style；不是 workspace ID。');
const ttlSchema = z.number().positive().refine(value => Number.isFinite(value)
  && Number.isSafeInteger(Math.ceil(Date.now() + value * 1000)), 'Invalid TTL');

function challenge(issuer: string, error?: 'invalid_token' | 'insufficient_scope', scope?: string): string {
  // All parts are server constants or values from the validated issuer setting.
  return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`
    + (error ? `, error="${error}"` : '')
    + (scope ? `, scope="${scope}"` : '');
}

function json(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { ...RESPONSE_HEADERS, ...headers } });
}

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string, authenticationChallenge?: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    ...(authenticationChallenge ? { _meta: { 'mcp/www_authenticate': [authenticationChallenge] } } : {}),
  };
}

/** Browser Origin restrictions supplement bearer auth; cookies never authorize MCP. */
function corsHeaders(request: Request, env: OAuthEnv, issuer: string): Record<string, string> | null {
  const origin = request.headers.get('origin');
  const configured = oauthAllowedOrigins(env);
  if (!origin) return {};
  if (origin !== new URL(issuer).origin && !configured.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-Api-Key, Content-Type, MCP-Protocol-Version, MCP-Session-Id, MCP-Method, MCP-Name, Last-Event-ID',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version, Retry-After',
  };
}

function createMemoryServer(env: OAuthEnv, access: Access, issuer: string): McpServer {
  const oauth = access.credential.kind === 'oauth';
  const server = new McpServer({ name: 'walle-memory', version: '0.3.0' }, {
    instructions: MEMORY_INSTRUCTIONS,
    capabilities: { tools: { listChanged: false }, resources: {} },
  });

  const metadata = (permission: Permission, readOnly: boolean, destructive: boolean, idempotent = false, appAccessible = readOnly) => ({
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false },
    // The official MCP SDK preserves the OpenAI-compatible security descriptor
    // in _meta. Permissions are enforced below and again inside D1, not by hints.
    _meta: { ui:{visibility:appAccessible ? ['model','app'] : ['model']},'openai/widgetAccessible':appAccessible, securitySchemes: oauth
      ? [{ type: 'oauth2', scopes: [`memory:${permission}`] }]
      : [{ type: 'apiKey', in: 'header', name: 'X-Api-Key' }] },
  });

  async function execute(permission: Permission, operation: (store: MemoryStore, tenantId: string) => Promise<Record<string, unknown>>, workspaceId?: string): Promise<CallToolResult> {
    const scope = `memory:${permission}`;
    if (!access.scopes.includes(scope)) {
      return toolError(`This connection requires ${scope} permission.`, oauth ? challenge(issuer, 'insufficient_scope', scope) : undefined);
    }
    const selected = access.workspaces.find(w => w.id === (workspaceId ?? access.tenant.id));
    if (!selected) return toolError('这个 workspace 不在此连接的授权范围内。请用 memory_workspaces 查看已授权空间。');
    // The store revalidates either credential inside the same D1 transaction
    // as each operation, including account status, ownership, scope and expiry.
    const store = new MemoryStore(env.DB, { ...access.credential, requiredScope: permission });
    try { await store.checkAccess(selected.id); return result(await operation(store, selected.id)); }
    catch (error) {
      if (error instanceof CredentialExpiredError) {
        return toolError('The connection is no longer authorized. Reconnect to continue.', oauth ? challenge(issuer, 'invalid_token') : undefined);
      }
      if (error instanceof Error && /fts5:|unterminated string|malformed MATCH|no such column:|syntax error/i.test(error.message)) {
        return toolError('Invalid full-text search query.');
      }
      // D1 errors may contain bound values. Never return or log them to clients.
      return toolError('The memory operation failed.');
    }
  }

  server.registerTool('memory_list', {
    title: '查看记忆索引', description: '查看已记录的待办、日程、偏好或项目索引；用于‘列出我的待办/看看项目记忆’。返回 key、摘要、更新时间与到期时间，不加载正文。prefix 为区分大小写的字面前缀，例如 tasks/。',
    inputSchema: z.strictObject({ prefix: boundedText(1024).optional(), workspace_id: workspaceSchema }),
    ...metadata('read', true, false, true),
  }, ({ prefix, workspace_id }) => execute('read', async (store,id) => ({ keys: await store.listKeys(id, prefix) }),workspace_id));

  server.registerTool('memory_get', {
    title: '读取记忆详情', description: '回忆一件事、查看任务详情或更新前读取原记录。返回正文、摘要、到期时间与访问元数据；不存在或已过期时 entry=null。读取会增加访问计数。',
    inputSchema: z.strictObject({ key: keySchema, workspace_id: workspaceSchema }),
    ...metadata('read', true, false, true),
  }, ({ key, workspace_id }) => execute('read', async (store,id) => ({ entry: await store.getEntry(id, key) }),workspace_id));

  server.registerTool('memory_search', {
    title: '查找已有记忆', description: '找以前记录过的事情，例如‘之前提到某个人/某个项目的记录’。FTS5 只搜索 key 和摘要，不搜索正文，不是语义/向量检索；最多20条。再用 memory_get 读取相关正文。',
    inputSchema: z.strictObject({ query: boundedText(2048, true), workspace_id: workspaceSchema }),
    ...metadata('read', true, false, true),
  }, ({ query, workspace_id }) => execute('read', async (store,id) => ({ results: await store.searchKeys(id, query) }),workspace_id));

  server.registerTool('memory_summary', {
    title: '回顾记忆索引', description: '回顾最近记录、整理已完成与未完成事项、恢复项目上下文时先读全量有效索引；不是自动生成的总结。根据更新时间筛选后，仅对相关 key 调 memory_get 核对状态与边界。',
    inputSchema: z.strictObject({ workspace_id: workspaceSchema }),
    ...metadata('read', true, false, true),
  }, ({ workspace_id }) => execute('read', async (store,id) => ({ entries: await store.getAllDescriptions(id) }),workspace_id));

  server.registerTool('memory_put', {
    title: '记住或更新一件事', description: '用户说‘记住/加个待办/做完了/更新进展/改截止日期’时保存或更新对应记忆，不执行待办本身。会替换 value 与 description；更新前先读取并保留未要求修改的内容。省略 ttl_seconds 会清除原到期时间，保留时请传剩余秒数。',
    inputSchema: z.strictObject({ key: keySchema, value: boundedText(256 * 1024), description: boundedText(8 * 1024), ttl_seconds: ttlSchema.optional(), workspace_id: workspaceSchema }),
    ...metadata('write', false, true),
  }, ({ key, value, description, ttl_seconds, workspace_id }) => execute('write', async (store,id) => {
    await store.upsert(id, key, value, description, ttl_seconds);
    return { ok: true, key };
  },workspace_id));

  server.registerTool('memory_update', {
    title: '修改已有记忆', description: '编辑 Walle Memory 中已有的记忆正文和摘要，保留原 key 与原到期时间，不新建或恢复已过期条目。先 memory_get 读取，传其 updated_at 为 expected_updated_at；版本已改变时返回 ok=false、reason=conflict，不覆盖其他会话的修改。用于界面点击保存或对话修改已有记录，需要 memory:write。',
    inputSchema: z.strictObject({ key: keySchema, value: boundedText(256 * 1024), description: boundedText(8 * 1024), expected_updated_at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), workspace_id: workspaceSchema }),
    ...metadata('write', false, true, false, true),
  }, ({ key, value, description, expected_updated_at, workspace_id }) => execute('write',
    (store,id) => store.updateExisting(id,key,value,description,expected_updated_at),workspace_id));

  server.registerTool('memory_delete', {
    title: '删除指定记忆', description: '按用户明确要求删除指定记忆；永久删除，需要 memory:delete。明确指定目标时不重复确认；清理范围含糊时先澄清。不会删除其他 workspace 或整个账户。',
    inputSchema: z.strictObject({ key: keySchema, workspace_id: workspaceSchema }),
    ...metadata('delete', false, true, true),
  }, ({ key, workspace_id }) => execute('delete', async (store,id) => ({ ok: true, key, deleted: await store.deleteEntry(id, key) }),workspace_id));

  server.registerTool('memory_gc', {
    title: '清理已到期记忆', description: '用户要求‘清理这个空间已到期的记忆’时使用。仅永久删除所选 workspace 的已过期条目，需要 memory:gc；不会删除仍有效的记忆。',
    inputSchema: z.strictObject({ workspace_id: workspaceSchema }),
    ...metadata('gc', false, true, true),
  }, ({ workspace_id }) => execute('gc', async (store,id) => ({ ok: true, deleted: await store.deleteExpired(id) }),workspace_id));

  server.registerTool('memory_workspaces', {
    title:'查看已授权的记忆空间', description:'查看此 MCP 连接中已授权的 workspace、默认空间和权限。需要切换空间或明确日常工作/项目/个人记忆的存储位置时使用；OAuth 只返回已选择且仍属于当前账户的空间，API Key 只返回绑定的单个空间。',
    inputSchema:z.strictObject({}), ...metadata('read',true,false,true),
  }, () => execute('read',async () => ({ workspaces:access.workspaces,default_workspace_id:access.tenant.id,permissions:access.scopes })));

  server.registerTool('memory_workbench', {
    title:'打开 Walle Memory', description:'在 MCP Apps 打开 Walle Memory。适用于“打开 Walle Memory/看看最近更新/浏览各种记忆”。可切换已授权 workspace，按类型/状态筛选，搜索 key 和摘要，查看正文与创建/更新/删除动态，并通过接口编辑保存已有条目。纯数据回顾可用 memory_summary。',
    inputSchema:z.strictObject({ workspace_id:workspaceSchema,prefix:boundedText(1024).optional(),query:boundedText(2048).optional(),offset:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(200).default(100) }),
    ...metadata('read',true,false,true),
    _meta:{ ...metadata('read',true,false,true)._meta,ui:{visibility:['model','app'],resourceUri:WORKBENCH_URI},'openai/outputTemplate':WORKBENCH_URI },
  }, ({workspace_id,prefix,query,offset,limit}) => execute('read',async (store,id) => ({
    ...await store.workbench(id,{prefix,query,offset,limit}),workspace:access.workspaces.find(w=>w.id===id),
    workspaces:access.workspaces,default_workspace_id:access.tenant.id,permissions:access.scopes,
  }),workspace_id));

  server.registerResource('walle-memory-workbench',WORKBENCH_URI,{title:'Walle Memory',mimeType:WORKBENCH_MIME},async uri => ({
    contents:[{uri:uri.href,mimeType:WORKBENCH_MIME,text:WORKBENCH_HTML,
      _meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}}} }],
  }));

  return server;
}

/** No server, transport, sessions or authenticated principal are shared across requests. */
export async function handleMcpRequest(request: Request, env: OAuthEnv): Promise<Response> {
  let issuer: string;
  let cors: Record<string, string> | null;
  try {
    issuer = oauthIssuer(env);
    cors = corsHeaders(request, env, issuer);
  } catch { return json({ error: 'OAuth is not configured' }, 503); }
  // A forwarded or rebound Host must not turn this resource into another origin.
  // The canonical issuer is operator configuration, never derived from Host.
  if (new URL(request.url).origin !== issuer) return json({ error: 'Unexpected resource origin' }, 403);
  if (!cors) return json({ error: 'Origin is not allowed' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...RESPONSE_HEADERS, ...cors } });

  const authorization = request.headers.get('authorization');
  const apiKey = request.headers.get('x-api-key');
  // Select the credential family by header presence, including empty or malformed
  // values. Never fall back after a failed OAuth check or combine authorities.
  if (authorization !== null && apiKey !== null) return json({ error: 'multiple authentication methods' }, 400, cors);
  const match = authorization?.length && authorization.length <= 1024 ? /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(authorization) : null;
  let access: Access | null = null;
  if (authorization !== null) {
    access = match ? await resolveOAuthAccess(env.DB, match[1], oauthResource(env)) : null;
  } else if (apiKey !== null && /^[A-Za-z0-9._~+\/-]{1,512}=*$/.test(apiKey) && apiKey.length <= 512) {
    // Reuse memory-only authority; the administrator secret is never consulted.
    const auth = await resolveMemoryAuth(env.DB, apiKey);
    if (auth) {
      const workspace = await env.DB.prepare('SELECT display_name,memory_type FROM tenants WHERE id=?')
        .bind(auth.tenant.id).first<{ display_name: string; memory_type: string }>();
      if (workspace) access = {
        tenant: auth.tenant, workspaces: [{ ...auth.tenant, ...workspace }],
        scopes: auth.scopes.map(scope => `memory:${scope}`),
        credential: { kind: 'api-key', keyHash: await hashKey(apiKey) },
      };
    }
  }
  if (!access) return json({ error: 'unauthorized' }, 401, {
    ...cors, ...(apiKey === null ? { 'WWW-Authenticate': challenge(issuer, authorization !== null ? 'invalid_token' : undefined) } : {}),
  });
  const rateKey = access.credential.kind === 'oauth' ? `mcp:${access.credential.tokenHash}` : `memory:${access.credential.keyHash}`;
  const retry = await consumeRateLimit(env.DB, rateKey, 300, 60);
  if (retry !== null) return json({ error: 'too many requests' }, 429, { ...cors, 'Retry-After': String(retry) });

  // Official SDK's web-standard handler uses fresh instances for both the modern
  // protocol and its 2025 stateless Streamable HTTP compatibility bridge.
  const handler = createMcpHandler(() => createMemoryServer(env, access, issuer), {
    legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: MAX_BODY_BYTES,
    maxSubscriptions: 0, keepAliveMs: 0,
  });
  const response = await handler.fetch(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({ ...RESPONSE_HEADERS, ...cors })) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
