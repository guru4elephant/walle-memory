# 账号、记忆空间与 API Key

此功能用于 Cloudflare Workers + D1 目标：管理员建号或受邀人注册后，用户可在部署同源的 `/account` 登录，管理自己的记忆空间，并签发空间专用 API Key。默认由管理员建号；仅 `REGISTRATION_MODE=invite` 启用 [邀请码注册](INVITATION_SIGNUP.md)。部署来源与历史验证范围见 [发布来源](RELEASE_PROVENANCE.md)。本页示例中的主机、Key、密码和 ID 均为占位符。

已有 Docker/Node 目标继续提供原来的租户与记忆 API，不实现本页的账号接口。两个目标共享原记忆 dashboard；Worker 另提供 `/account` 账号页面。不要把 D1 migration 应用到 Node 服务的自动建表数据库。

## 1. 数据模型与授权边界

```text
Account（邮箱、显示名称、密码登录）
  └─ Memory Space（复用 tenants，一次只归属一个账号）
       ├─ Memory（原 tenant_id + key 存储与检索）
       └─ API Key（空间、权限、可选到期时间、撤销状态）
```

| 对象 | 主要字段 | 含义 |
| --- | --- | --- |
| Account | `id`, `email`, `display_name`, `created_at` | 邮箱会去除两端空白并转换为小写；密码哈希不在响应中返回。 |
| Space / tenants | `id`, `name`, `display_name`, `memory_type` | `id` 仍是原租户 ID；`name` 保留旧 API 中的租户名称，`display_name` 用于用户展示。 |
| 空间归属 | 数据库字段 `owner_account_id` | 服务端按登录账号校验归属。此字段用于授权，不保证出现在公共 Space 响应中。 |
| 旧 Key 状态 | `legacy_key_active` | 响应中的布尔值，由 `legacy_key_revoked_at` 推导；不会返回旧 Key 原文或哈希。 |
| Scoped Key | `id`, `space_id`, `label`, `prefix`, `scopes`, `expires_at`, `revoked_at` | `prefix` 是密钥识别片段，不是记忆路径前缀或授权范围。时间字段使用 Unix 毫秒；无到期时间为 `null`。 |

`memory_type` 是空间的分类标签，例如 `general`、`profile`、`project`、`agent`；允许以小写字母开头的小写字母、数字、下划线或短横线，最长 64 个字符。相同类型可以创建多个空间，分类标签本身不构成额外权限。

每个新 Key 只绑定一个空间。记忆读写、列表、摘要、FTS 检索、TTL 隐藏和 GC 均使用认证解析出的空间 ID，不接受客户端任意指定其他空间。账号 Cookie 用于账号和 Key 管理；调用记忆 API 仍须发送 `X-Api-Key`。管理员 `API_KEY` 用于 `/admin/`，不能代替记忆 Key 调用 `/memory`。

`user/`、`project/` 等记忆键前缀仍只是组织约定。在同一空间中，有 `read` 权限的 Key 可读取该空间全部记忆；当前没有按路径前缀、单条记录或成员角色分配权限。

## 2. 推荐使用流程

### 管理员建号

打开部署同源的 `/account`，展开页面中的「管理员工具」。用户自己输入对应 Cloudflare `API_KEY` Secret 的管理员 Key；不要输入租户 Key 或新空间 Key。填写「显示名称」「邮箱」和至少 12 个字符的「初始密码」，点击「创建账号」。管理员 Key 每次请求后会从输入框清除，不保存在浏览器存储中；读取列表或再次操作前需重新输入。

该操作调用 `POST /admin/accounts`，只返回账号信息，不创建登录会话。使用者随后在同页的正常登录表单输入刚创建的邮箱和密码。初始密码通过安全渠道交给使用者，不写入仓库、日志或普通聊天。

以下均为请求结构示意，尖括号内容是占位符，不是真实凭据；不要将替换后的密码或 Key 放入 shell 历史。

```http
POST /admin/accounts
Content-Type: application/json
X-Api-Key: <ADMIN_KEY>

{"email":"user@example.invalid","display_name":"示例用户","password":"<PASSWORD_AT_LEAST_12_CHARACTERS>"}
```

已配置管理员 Key 时，错误或缺失的管理员 Key 返回 401；未配置或只有空白时，管理员接口返回 503。账号邮箱重复返回 409。`GET /admin/accounts` 返回账号列表，不返回密码或会话秘密。

### 用户登录、创建空间和签发 Key

1. 在服务同源的 `/account` 页面输入已有账号邮箱和密码，正常登录。邀请码模式启用后，受邀人也可先按 [邀请流程](INVITATION_SIGNUP.md) 注册。
2. 创建记忆空间，填写显示名称和 `memory_type`，例如 `project`、`profile` 或 `general`。新空间默认没有可用的旧式租户 Key。
3. 选择该空间，在「签发 API Key」中填写 Key 名称（`label`），勾选需要的 `scopes`。按需填写「到期时间」；该时间按设备时区显示，留空表示长期有效。
4. 点击「签发 Key」，在一次性显示窗口中立即保存完整 Key。创建响应中的 `api_key` 只返回一次；列表只能看到识别前缀、权限及状态，无法找回原文。遗失时签发新 Key，并撤销旧 Key。
5. 客户端继续调用原 `/memory` 等路径，使用这个空间 Key 的 `X-Api-Key` 请求头。无需在记忆路径中加入账号或空间 ID。

```http
POST /account/spaces
Content-Type: application/json
Origin: <SAME_ORIGIN>
Cookie: __Host-walle_session=<SESSION_COOKIE>

{"display_name":"项目 Alpha","memory_type":"project"}
```

```http
POST /account/spaces/<SPACE_ID>/keys
Content-Type: application/json
Origin: <SAME_ORIGIN>
Cookie: __Host-walle_session=<SESSION_COOKIE>

{"label":"项目只读客户端","scopes":["read"],"expires_at":null}
```

```http
GET /memory/search?q=alpha
X-Api-Key: <SPACE_API_KEY>
```

以上 Cookie 名用于 HTTPS；本地 HTTP 开发使用 `walle_session`。浏览器会管理 HttpOnly 会话 Cookie。示意中的 Cookie 占位符仅用于说明协议，不需要也不应从浏览器脚本读取真实会话令牌。

### 权限范围

| Scope | 授权操作 |
| --- | --- |
| `read` | `GET /summary`、`GET /memory`、`GET /memory/search`、`GET /memory/:key`。读取条目仍会更新原有访问计数。 |
| `write` | `POST` / `PUT /memory/:key`，包括写入值、描述和 TTL。 |
| `delete` | `DELETE /memory/:key`。 |
| `gc` | `POST /memory/gc`，仅清理该空间已过期记忆。 |

至少选择一个有效 Scope。有效 Key 缺少所需权限返回 403；错误、过期或已撤销的 Key 返回 401。撤销后不能重新启用，可签发替代 Key。`expires_at` 必须是未来的 Unix 毫秒整数；省略或 `null` 表示不设到期时间。

记忆修改在 D1 batch 的同一事务中重新校验当前 Key、权限、到期及账号状态，覆盖写入、删除、GC 与读取时访问计数的更新。如果请求在读取 body 时延迟，期间 Key 已撤销，则后续修改返回 401，不写入数据。已经进入同一事务的修改与撤销按 D1 的事务顺序完成；撤销不会追溯取消先完成的事务。

删除空间会级联删除该空间记忆和 Key，属于数据删除；撤销 Key 不删除记忆。应用没有空间删除恢复接口，操作前应确认目标并采用已验证的备份方案。

## 3. 接口速查

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `GET /auth/config` | 公开 | 返回 `registration_mode: "admin"` 或 `"invite"`。 |
| `POST /auth/login` | 同源请求 | `{email, password}`，成功设置会话 Cookie。 |
| `POST /auth/register` | 同源请求 | 新版仅邀请模式接受 `{email, password, display_name?, invitation_code}`；默认返回 403。 |
| `GET /auth/me` | 会话 Cookie | 返回当前账号。 |
| `POST /auth/logout` | 会话 Cookie / 同源请求 | 注销当前会话并清除 Cookie。 |
| `GET /admin/accounts` | 管理员 Key | 列出账号。 |
| `POST /admin/accounts` | 管理员 Key | 创建账号。 |
| `GET` / `POST /admin/invitations` | 管理员 Key | 新版邀请列表及签发；完整邀请码仅创建时返回。 |
| `DELETE /admin/invitations/:id` | 管理员 Key | 新版撤销邀请，阻止后续注册。 |
| `POST /admin/accounts/:accountId/spaces/:tenantId/claim` | 管理员 Key | 将未归属的旧租户分配给指定账号；请求体可省略，或提供 `display_name`、`memory_type`。 |
| `POST /admin/tenants/:id/revoke-legacy-key` | 管理员 Key | 撤销指定租户的旧 Key。 |
| `GET /account/spaces` | 会话 Cookie | 仅列出当前账号的空间。 |
| `POST /account/spaces` | 会话 Cookie / 同源请求 | 创建 `{display_name, memory_type?}`；类型默认 `general`。 |
| `DELETE /account/spaces/:id` | 会话 Cookie / 同源请求 | 删除当前账号所属空间及其记忆、Key。 |
| `GET /account/spaces/:id/keys` | 会话 Cookie | 列出所属空间 Key 的非秘密元数据。 |
| `POST /account/spaces/:id/keys` | 会话 Cookie / 同源请求 | 签发 `{label, scopes, expires_at?}`，仅创建响应返回 `api_key` 原文。 |
| `DELETE /account/spaces/:id/keys/:keyId` | 会话 Cookie / 同源请求 | 撤销 Key；原文不可恢复。 |
| `POST /account/spaces/:id/revoke-legacy-key` | 会话 Cookie / 同源请求 | 空间所有者撤销该空间旧 Key。 |

账号管理请求体须为 `application/json` 对象，最大 16 KiB。空间不存在或不归当前账号时返回 404；用户不能自行认领未归属的历史租户，也不能将空间转给另一个账号。管理员对已归属其他账号的空间再次分配会返回 409；同一账号重复分配不更换空间 ID。

## 4. 旧租户接入与兼容

原 `/admin/tenants` 创建、列表与删除路径继续工作，原记忆路径、`X-Api-Key`、返回形状、时间单位和 TTL 行为保留。旧租户在升级后初始仍未归属账号，原 Key 继续获得该租户的 `read`、`write`、`delete`、`gc` 权限，直到明确撤销。

接入已有数据时，先由管理员创建账号，再使用 `claim` 路径指定原 `tenantId`。可以同时设置展示名称和类型；不提供这些字段时保留迁移后的值。分配不会改写记忆的 `tenant_id`、Key 原哈希或访问计数，也不会自动撤销旧 Key。

```http
POST /admin/accounts/<ACCOUNT_ID>/spaces/<EXISTING_TENANT_ID>/claim
Content-Type: application/json
X-Api-Key: <ADMIN_KEY>

{"display_name":"历史项目记忆","memory_type":"project"}
```

所有者随后签发 Scoped Key，替换客户端配置并验证读取、写入及检索，再明确撤销旧 Key。只签发 Scoped Key 不会缩减旧 Key 的完整权限；要完成权限收敛，必须处理仍有效的旧 Key。未归属租户可先继续使用原客户端，待管理员确认归属后逐个接入。

首次撤销仍有效的旧 Key 时，服务端在单条 SQL 中同时记录撤销时间，并把 `api_key_hash` 替换为一个未签发随机令牌的哈希。原哈希不可恢复，原 Key 即使交给只查询 `api_key_hash` 的旧 Worker 也无法重新使用。重复撤销不会再次更换哈希；新建账号空间从一开始就没有可用的旧 Key。

原记忆 dashboard 位于 `/`，继续按当前输入的记忆 Key 工作；新 `/account` 页面使用账号会话。原 dashboard 的 Key 保存在同源 `localStorage`，请只在可信设备和可信域名上使用，并避免输入管理员 Key。只读 Key 不能执行界面中的保存、删除或 GC 操作，服务端会按 Scope 拒绝。

Worker 原有适配差异也继续保留：prefix 为区分大小写的字面匹配，FTS 仅搜索 key 和 description，过期记录对列表、读取、检索与摘要不可见，GC 仅清理调用者空间。无分页的整空间列表与摘要仍可能产生较多 D1 读取。

## 5. 注册、会话、密码与限流

`REGISTRATION_MODE` 只有值严格等于 `invite` 才启用邀请码注册；未设置、`admin`、历史值 `public` 或其他值均为管理员建号模式。`/account` 读取 `/auth/config` 决定是否展示入口。邀请码的次数、到期、撤销及原子兑换规则见 [邀请码注册说明](INVITATION_SIGNUP.md)。切换模式不改变已有账号、会话、空间或 Key。

所有账号 Cookie 写操作及登录、注册、注销要求 `Origin` 与请求 URL 完全同源，并拒绝 `Sec-Fetch-Site: cross-site`。部署环境要求 HTTPS；仅 `localhost`、`127.0.0.1`、`[::1]` 的本地开发请求允许 HTTP。生产 HTTPS 会话使用 `__Host-walle_session`，带有 `Secure`、`HttpOnly`、`SameSite=Strict`、`Path=/`，不设置 `Domain`，防止同级子域通过父域 Cookie 覆盖该会话。仅本地 HTTP 使用 `walle_session`。期限为 7 天，数据库只保存会话令牌的 SHA-256 哈希。

密码至少 12 个字符，采用随机独立 salt 和 PBKDF2-HMAC-SHA-256。当前迭代次数为 100,000；每条账号记录保存迭代次数，以支持后续兼容升级。随机 API Key 使用 Web Crypto 生成，数据库只保存 SHA-256 哈希；不使用可逆加密保存 Key 原文。

| 限制 | 固定窗口额度 |
| --- | --- |
| 登录 | 每 IP 20 次 / 15 分钟；每邮箱 10 次 / 15 分钟。 |
| 邀请注册（仅显式启用时） | 每 IP 5 次 / 小时；每邮箱 3 次 / 小时。 |
| 签发邀请 | 管理员每小时 30 次尝试；最多 100 个有效且有剩余次数的邀请。 |
| 创建空间 | 每账号 20 次 / 小时；每账号最多 100 个空间。 |
| 签发 Key | 每账号 30 次 / 小时；每空间最多 100 个仍有效且未撤销的 Key。 |
| 记忆 API | 每 Key 300 次 / 分钟。旧 Key 也受此限制。 |

超过窗口额度返回 429 和 `Retry-After`。限流使用 D1 原子计数及有界清理；边缘 IP 使用 `CF-Connecting-IP`，本地无该头时共用 `unknown` IP 桶。限流增加了数据库读写，应在实际负载下验证 D1 用量。

这是当前服务的基础账号功能。目前没有邮箱验证、找回或重置密码、修改密码、MFA、多人共享空间、账号禁用管理界面及邮件发送流程。新版邀请码允许受邀人创建独立账号，不提供共享空间成员功能。账号 schema 预留 `disabled_at` 并在鉴权时检查，不代表已提供完整账号运维接口。没有引入外部身份服务、邮件服务或新的收费依赖。

登录对未知账号与错误密码执行相同的密码派生流程，并统一返回 401 的 `invalid email or password`，不通过分支错误内容披露账号是否存在。新版邀请注册对兑换失败使用通用措辞，但成功为 201、邮箱已存在的失败为 400，邀请持有者仍可通过结果差异推断邮箱是否已使用；通用错误文字不能消除这项风险。

## 6. D1 增量迁移与回滚限制

[0001_initial.sql](../walle-memory-worker/migrations/0001_initial.sql) 创建新数据库的原租户、记忆和 FTS schema。[0002_accounts_spaces_keys.sql](../walle-memory-worker/migrations/0002_accounts_spaces_keys.sql) 是该 schema 的增量迁移：

- 新增 `accounts`、`account_sessions`、`api_keys`、`auth_rate_limits` 及索引。
- 给 `tenants` 增加归属、展示名称、类型和旧 Key 撤销时间；展示名称初始化为原 `name`，类型初始化为 `general`，归属与撤销时间初始为空。
- 不重建 `memory` 或 FTS；保留原租户 ID、记忆 `rowid`、原 Key 哈希、访问计数、TTL、FTS 虚表和触发器。
- 不自动创建账号、不自动认领租户、不签发 Key，也不撤销旧 Key。

[0003_registration_invitations.sql](../walle-memory-worker/migrations/0003_registration_invitations.sql) 只有三条 DDL：新增邀请表与两个索引。不修改已有账号、密码、会话、租户、记忆、FTS 或 Key，也不预置邀请码。

迁移前核对真实 schema、Wrangler 的 `d1_migrations` 历史和恢复方案。**手工执行 SQL 不会自动建立 Wrangler 迁移记录；已有 schema 不能据此重放完整 migration 目录。** 先处理准确的历史基线，再应用缺失的增量变更；已存在的 `0001`、`0002`、`0003` 不应重复执行。新数据库可按 [Worker README](../walle-memory-worker/README.md) 依次应用完整目录。已有部署的历史事实见 [发布来源](RELEASE_PROVENANCE.md)。

上线验收应覆盖真实登录、业务读写、权限、隔离、撤销状态以及密码派生和 D1 用量。`/health` 是存活检查，不能替代这些验收。

回滚不等于仅更换旧 Worker。旧 Key 撤销通过替换原哈希保持不可恢复，回退旧 Worker 不会让原 Key 复活；但旧 Worker 不识别账号 `disabled_at`，仍可能允许已禁用账号尚未撤销的旧 Key 访问。它也不识别 Scoped Key、权限范围和账号会话，使用新 Key 的客户端会失去访问。应选择继续识别账号与权限状态的兼容版本，或制定包含停写、客户端切换、权限复核和数据恢复的回滚方案。

不要为了回滚直接删除新增表、清空归属字段或删除空间，这会丢失账号、会话、Key 元数据，甚至级联删除记忆。新增 schema 通常可先保留；没有自动 down migration。恢复旧数据也可能恢复旧 Key 状态，必须核对 Key 生命周期并终止失效会话。FTS5 备份和重建应按 [Worker 运维说明](../walle-memory-worker/README.md#d1-operations-and-limits) 验证，不能假定普通 SQL export 一定覆盖虚表。

## 7. 本地开发与验证

按 [Worker README](../walle-memory-worker/README.md#local-development) 安装依赖并创建本地开发数据库。仅使用本地临时凭据；`.dev.vars`、D1 状态、日志和构建产物不应提交。未设置 `REGISTRATION_MODE` 即使用默认管理员建号模式；本地设置为 `invite` 不影响其他部署。

两个部署目标分别验证：Worker 使用 Node 24 和临时 Miniflare/D1，Node SQLite 目标使用 Dockerfile 对应的 Node 22。Worker 测试覆盖原租户 API、迁移前后数据、账号归属、空间间 CRUD/FTS/TTL/GC 隔离、所有 Scope、Key 生命周期、同源会话写保护、注册模式、邀请码原子兑换与限流。各目标的可复现命令和可选浏览器流程见 [验证指南](VALIDATION.md)；这里不把历史结果作为当前检查结果。

## 8. 本机 Codex profile 客户端

仓库的 [walle-memory-profiles skill](../skills/walle-memory-profiles/SKILL.md) 使用 Python 标准库，按明确 `--user` 选择本机 profile alias，再读取对应空间 Key 的 macOS Keychain 引用。用户名不上传到服务端，也不能替代 Key 取得他人空间。未指定用户、映射或凭据不可用时失败，不静默切换到其他 profile；管理员 Key 不用于日常记忆 CRUD。

参照 [skill 配置说明](../skills/walle-memory-profiles/references/setup.md) 安装。安装文件不自动建立用户名与空间映射，也不授权录入或持续使用真实 Key；用户需明确选择映射和存储方案，并亲自隐藏输入。脚本不接受 Key 命令行参数、明文后备或重定向。删除和 GC 的本地确认参数不扩大服务端 Scope。

安装本机 skill 不会自动创建云端工具；跨设备使用需要可执行这台 Mac 上任务的连接或另外配置受支持的服务端工具。仓库 [tests](../tests/) 包含 58 项使用合成凭据、mock Keychain 和本地 HTTP 的标准库测试；它们不读取真实秘密或验证实际 Keychain ACL。
