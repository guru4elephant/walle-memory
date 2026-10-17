# Workers MCP 与可续期 OAuth 连接

本地候选版还支持空间 API Key 二选一鉴权；配置、兼容性和部署状态见 [MCP API Key 指南](MCP_API_KEY.md)。

2026-10-11 已完成单独获批的生产迁移与发布，具体版本、检查结果和首次连接步骤见
[公开变更与验证摘要](PUBLIC_CHANGE_SUMMARY.md)。以下配置示例仍适用于其他独立部署。

此功能属于 `walle-memory-worker/`，建立在已有账户、会话、空间和 scoped key 模型之上。MCP 客户端通过 OAuth 登录账户、选择一个空间并批准权限，再保存和刷新连接凭据。临时浏览器被回收后，只要客户端仍保存有效的 refresh token，就不需要重新输入空间 API Key。客户端自身删除连接或丢失凭据仍需重新授权；本实现不承诺连接永久有效。

原有 `X-Api-Key` REST 接口、账户页的 Key 管理和 Docker / Node SQLite 目标保持兼容。OAuth 不创建隐藏空间 Key，不把 access token 转换成 API Key，也不允许通过账户 Cookie 直接调用 MCP。Node 目标暂不提供这些 OAuth 和 MCP 路由。

## 连接和隔离模型

每份 OAuth 授权固定绑定账户、已选择的空间、默认空间、客户端、`resource` 和获批权限。空间只在本站授权页中选择；之后由服务端从 token 推导。可传 `workspace_id` 选择授权范围内的空间。MCP 工具不接受 `space_id`、`tenant_id`、账户名或其他身份参数，额外参数会被拒绝。空间 API Key 始终只绑定一个空间。

OAuth 状态保存在 D1，原始 code、access token、refresh token 和 CSRF token 不持久化；服务端使用其哈希查找和校验。原始令牌只在对应协议响应中交给客户端。客户端负责安全保存、原子更新 refresh token，避免把令牌写入聊天、日志、仓库、浏览器页面存储或本地技能文件。

内存操作在 D1 `batch()` 事务内再次检查 token 到期、授权到期与撤销、账户停用、空间归属、资源和权限；读取更新访问计数时也进行相同检查。已经在撤销事务之前完成提交的操作不能被撤销操作倒转。请求虽然已开始，但若其内存事务排在撤销之后，则不得使用之前的鉴权结果继续读写。空间删除会使授权失去可用的空间，不会让 token 落入其他空间。

## 接口与权限

假设规范服务 origin 为 `https://memory.example.invalid`，资源固定为 `https://memory.example.invalid/mcp`。以下地址均为占位示例。

| 路径 | 用途 |
| --- | --- |
| `POST /mcp` | OAuth Bearer 或 `X-Api-Key` 空间 Key，二选一的 MCP 请求。 |
| `GET /.well-known/oauth-protected-resource/mcp` | `/mcp` 资源元数据；根路径 `/.well-known/oauth-protected-resource` 也可发现。 |
| `GET /.well-known/oauth-authorization-server` | issuer、授权、token、注册、撤销端点及 S256 能力。 |
| `POST /oauth/register` | 为 public client 动态注册准确的回调 URI；不签发 client secret。 |
| `GET /oauth/authorize` | 本站账户登录和空间授权页面。 |
| `GET /oauth/authorize/context` | 页面专用：同源会话下生成一次性、会话绑定的同意请求。 |
| `POST /oauth/authorize` | 页面专用：校验 Origin、会话和 CSRF 后同意或拒绝；返回已校验的回调地址。 |
| `POST /oauth/token` | form 编码的授权码交换或 refresh token 轮换。 |
| `POST /oauth/revoke` | form 编码的 RFC 7009 撤销。 |
| `GET /account/connections` | 当前账户的授权连接和生命周期元数据，不返回凭据。 |
| `DELETE /account/connections/:id` | 当前账户撤销一份连接；需要同源请求。 |

MCP 使用官方 `@modelcontextprotocol/server` 的 Web Standard 请求处理器。当前协议为 `2026-07-28`，同时保留 SDK 的 `legacy: 'stateless'` 模式处理 2025 年客户端的初始化和后续请求；不维护 MCP 长连接会话。`GET /mcp` 和 `DELETE /mcp` 返回 405。每个实际请求需要 OAuth Bearer 或 `X-Api-Key` 空间 Key 之一；Cookie 和管理员 Key 不能授权 MCP，同时提供两种鉴权 Header 返回 400。[SDK Worker 用法](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard.html)、[旧客户端兼容](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients.html)

| 工具 | 参数 | OAuth 权限 |
| --- | --- | --- |
| `memory_list` | `prefix?` | `memory:read` |
| `memory_get` | `key` | `memory:read` |
| `memory_search` | `query` | `memory:read` |
| `memory_summary` | 无 | `memory:read` |
| `memory_put` | `key`, `value`, `description`, `ttl_seconds?` | `memory:write` |
| `memory_update` | `key`, `value`, `description`, `expected_updated_at` | `memory:write` |
| `memory_delete` | `key` | `memory:delete` |
| `memory_gc` | 无 | `memory:gc` |
| `memory_workspaces` | 无 | `memory:read` |
| `memory_workbench` | `workspace_id?`, `prefix?`, `query?`, `offset?`, `limit?` | `memory:read` |

除 `memory_workspaces` 外，各工具可传 `workspace_id`，省略时使用连接默认空间；API Key 只能指定自己绑定的空间。

工具沿用现有 memory store 的 FTS、TTL、值类型和输入界限。`memory_get` 未命中时返回 `entry: null`；删除不存在的条目返回 `deleted: false`。`memory_summary` 仅返回索引，不调用模型。OAuth 权限名带 `memory:` 前缀，原 REST scoped key 的权限名不变。

无凭据或无效 OAuth token 返回 HTTP 401，并通过 `WWW-Authenticate` 给出资源发现地址。通过 Bearer 检查后，工具权限不足或事务内授权失效返回 MCP `isError` 结果及 `mcp/www_authenticate` challenge；这类已处理的工具请求可使用 HTTP 200。API Key 失败不会附带 OAuth challenge，也不会尝试另一种鉴权。Origin 不符合要求返回 HTTP 403。工具元数据随本次鉴权方式返回 OAuth 或 API Key 描述。[MCP 授权发现](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)、[OpenAI 认证约定](https://developers.openai.com/plugins/build/auth)

## OAuth 协议和生命周期

- 使用 `response_type=code`、S256 PKCE、准确注册的 `redirect_uri` 和准确的 `resource`。`code_verifier` 只能在 token 交换时提供。授权码绑定客户端、回调、资源、权限和 PKCE，并原子消费，不能再次交换。
- 注册只支持 `token_endpoint_auth_method=none` 的 public client，授权码和 refresh token 两种 grant。应用名称是注册方自报信息；授权页同时显示 client ID、回调地址、账户、资源和操作权限。用户必须明确选择一个自己的空间，即使只有一个空间也不会默认授权。
- 回调 URI 按完整字符串准确匹配；不支持通配符、URL 凭据或 fragment。生产回调需 HTTPS。只有本地 HTTP issuer 才允许 loopback HTTP 回调，供本地测试使用。
- token 和 revoke 请求使用 `application/x-www-form-urlencoded`。客户端在授权和 token 请求中携带 `resource`，刷新不得扩大 scope、改变客户端或切换资源。客户端注册信息需要跨刷新保留，不能每次刷新重新注册。
- access token 为 10 分钟。一次授权的绝对期限为 90 天，30 天没有成功刷新则闲置过期；刷新不能延长 90 天的绝对上限。授权页面请求为 10 分钟，授权码为 5 分钟。
- refresh token 每次使用都会原子轮换。重放已使用的 refresh token 会撤销同一授权 family，包括当前 access token 和替代 refresh token。此策略保守处理被盗凭据，**同一连接并发刷新、刷新响应丢失后重试旧 token，也可能导致整份连接需要重新授权**。客户端应按连接串行刷新并可靠保存替代 token。
- 用户可在 `/account` 的“已连接应用”中查看应用、空间、权限、授权时间、闲置到期时间和最晚到期时间，并撤销连接。撤销不删除记忆。退出账户页面的登录会话不等于撤销已连接应用；如需断开应用，应显式撤销。

一次批准会签发可刷新连接，授权页明确说明续期行为。可请求 `scope=memory:read memory:write offline_access`；`offline_access` 是可选的续期提示，不增加内存权限，也不单独构成有效授权。即使未请求它，用户批准的连接仍可刷新。此 scope 仅在授权服务器元数据中公布，不放入 MCP 资源权限或资源 challenge。授权流程中保留客户端 `state`，成功和拒绝回调的 `iss` 与元数据 issuer 一致。[PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)、[OAuth 安全 BCP](https://www.rfc-editor.org/rfc/rfc9700.html)、[Token 撤销](https://www.rfc-editor.org/rfc/rfc7009.html)

## 配置与浏览器边界

| 配置 | 含义 |
| --- | --- |
| `OAUTH_ISSUER` | 必填的规范 origin，例如 `https://memory.example.invalid`。只含 scheme、host 和必要端口，不含路径、query、fragment 或凭据。缺失或无效时 OAuth/MCP 关闭。 |
| `OAUTH_ALLOWED_ORIGINS` | 可选 JSON 数组，列出允许访问 OAuth 协议端点与 MCP 的准确浏览器 origin。默认空数组，issuer 自身已允许。无 Origin 的服务端客户端无需加入。 |

issuer 不从入站 Host 动态生成。更改部署域名会改变 issuer 和 resource，原 token 不应在新资源上继续使用；迁移域名需要重新规划客户端和授权。localhost 与 `127.0.0.1` 是不同 origin，本地配置和实际访问地址必须一致。

账户登录、同意页面和连接管理不向其他 origin 开放。OAuth 页面不使用 localStorage/sessionStorage、外部资源或动态 HTML 插入；CSRF 值仅存在于页面内存。同意 POST 同时需要严格 Origin、当前会话和一次性 CSRF。页面的 context GET 使用 `X-Walle-OAuth: 1`，并验证浏览器 `Sec-Fetch-Site: same-origin` 或明确相符的 Origin。账户 Cookie 的 HttpOnly / SameSite 保护保留；跨站首次打开授权页后，页面再发起同源会话请求。[MCP HTTP Origin 要求](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)

注册限额为每 IP 每小时 10 次、全局每小时 100 次，总客户端上限 1,000。token 和 revoke 各端点按每 IP 每分钟 120 次限制；同意请求每账户每小时 60 次，每账户最多 100 份待处理请求和 100 份有效授权。注册时批量清理绝对期限已过的授权，以及创建超过 24 小时、没有授权且没有待处理同意请求的客户端；每类每次最多清理 100 条。正在使用的客户端会保留。遭遇 429 应退避，配额饱和返回的暂时不可用也不应触发无限重新注册。限制状态和清理会产生 D1 写入，应纳入容量预算。

## 仅在临时本地 D1 中验证

使用 Node 24，从 Worker 目录运行。下列命令不涉及远程 D1：

```sh
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars
# 在被 Git 忽略的 .dev.vars 中自行设置仅用于本地测试的管理员值。
# 保留 OAUTH_ISSUER=http://localhost:8787，并从相同 origin 打开页面。
WALLE_OAUTH_TEST_STATE="$(mktemp -d /tmp/walle-memory-oauth.XXXXXX)"
npx wrangler d1 migrations apply DB --local --persist-to "$WALLE_OAUTH_TEST_STATE"
npx wrangler dev --local --persist-to "$WALLE_OAUTH_TEST_STATE" --port 8787
```

此目录应是新建的临时 D1 状态，不能指向既有开发数据库。打开 `http://localhost:8787/account`，仅使用合成账户和测试数据；管理员凭据由测试者在本站页面中输入，不从真实聊天或凭据存储复制。停用本地服务后，测试者可删除本次创建的临时目录。

在另一个终端执行自动化检查：

```sh
cd walle-memory-worker
XDG_CONFIG_HOME="$PWD/.local-validation/config" WRANGLER_SEND_METRICS=false \
  WRANGLER_LOG_PATH="$PWD/.wrangler/oauth-validation.log" npm test
```

该命令包含类型检查、Wrangler dry-run 构建和独立测试 D1 上的测试。OAuth UI 的 VM 测试可单独运行：

```sh
node --test test/oauth-ui.test.mjs
```

完整发布前应检查 PKCE、授权码重放、刷新轮换与重放/并发、scope/resource/client 隔离、Origin/CSRF、撤销后的在途读写、账户停用、空间删除、到期、迁移保留和原 REST/Node/技能回归。命令说明和代码中的测试不等于一次已完成的验证；本次实际通过项、运行时版本和环境限制应以任务验证报告为准。已有目标的命令见 [VALIDATION.md](VALIDATION.md)。

## 增量迁移与后续上线

新增 [0004_oauth.sql](../walle-memory-worker/migrations/0004_oauth.sql) 只创建 OAuth 客户端、待同意请求、授权、授权码、access token、refresh token 及索引。它不创建账户、空间或凭据，不变更已有记忆、FTS、Key、邀请码或会话。新临时数据库按顺序应用 `0001` 至 `0004`；已有数据库需要先核对真实 schema 与 `d1_migrations`，**只应用缺失的 `0004`**，不能重放旧迁移。

远程迁移、生产配置、生成/绑定生产凭据、推送、合并和部署均属于单独的上线动作，本地开发和测试不包含这些步骤。得到相应批准后，上线顺序为：确认备份及恢复方案 → 核验目标数据库和迁移记录 → 应用唯一缺失的增量迁移 → 配置规范 HTTPS issuer 及必要 origin → 发布已验证 Worker → 使用隔离测试空间做真实客户端验收。回滚旧 Worker 会关闭新连接功能；不要通过恢复旧凭据状态让已撤销的连接重新生效。保留 OAuth 表通常比直接回滚数据安全，具体恢复方案需结合实际 D1 状态审查。

## ChatGPT 首次连接与真实客户端验收

1. 先准备经过批准、ChatGPT 可访问的 HTTPS 测试端点。云端 ChatGPT 不能直接访问本机 localhost；本地测试不能证明真实客户端兼容性。
2. 按 ChatGPT 当时可用的自定义 MCP / 开发者连接界面添加 `https://<服务域名>/mcp`，选择 OAuth。此实现使用动态客户端注册；不填写空间 API Key 或临时浏览器 Cookie。若某客户端强制要求 confidential client secret，此版本不支持该模式，不应填入伪造值或改用管理员 Key。[OpenAI 连接步骤](https://developers.openai.com/plugins/deploy/connect-chatgpt)
3. 使用客户端实际提供的准确回调，不硬编码历史地址。当前 OpenAI 文档说明：授权服务器声明并正确实现 `authorization_response_iss_parameter_supported: true` 时，可用 `https://chatgpt.com/connector_platform_oauth_redirect`；其他路径使用连接专属的 `https://chatgpt.com/connector/oauth/{callback_id}`。以实际管理界面和发现元数据为准，本实现的成功与拒绝回调均带一致的 `iss`。[OpenAI OAuth 回调规则](https://developers.openai.com/plugins/build/auth)
4. 用户在 Walle Memory 自己的 HTTPS 域名上输入账户凭据，核对应用回调地址、空间和权限，再亲自批准。开发者或代理只提供安全交接，不代填账户密码、MFA 或生产 Key。
5. 在隔离空间验证工具发现、读写和错误处理，再验证 access token 过期后的刷新、撤销后的访问失败、重新授权和不同空间隔离。刷新令牌由客户端管理，验收不应把它复制到聊天或日志中。
6. 浏览器会话被清理后重新使用同一已连接应用，确认客户端保存的连接可继续使用。再测试在 Walle Memory 账户页撤销并重新连接。真实客户端可能有独立的连接保留策略，其限制无法由本服务保证。

动态注册是当前 MCP 仍保留的兼容方式；当前规范已优先推荐预注册或客户端元数据文档。此版本不实现 URL 客户端元数据抓取，也不接受任意远程地址作为可信客户端配置。使用 D1 自管 OAuth 状态是为了让刷新、撤销和空间访问共用事务边界；通用 KV OAuth 中间件的存储与轮换语义不能直接代替这些保证。[MCP 客户端注册](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
