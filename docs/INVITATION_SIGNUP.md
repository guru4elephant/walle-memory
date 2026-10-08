# 邀请码注册

邀请码注册是 Cloudflare Workers + D1 目标的可选模式。启用后，受邀人在部署同源的 `/account` 使用有效邀请码注册，再创建自己的空间和空间专用 Key。账号功能见 [账号使用说明](ACCOUNTS_AND_SPACES.md)，源码与部署来源见 [发布来源](RELEASE_PROVENANCE.md)。以下 API 路径均相对于部署 origin；所有凭据示例均为占位符。

## 注册模式

`REGISTRATION_MODE=invite` 才允许邀请码注册。未设置、`admin`、历史值 `public` 及其他值均返回管理员建号模式，拒绝 `POST /auth/register`，避免配置旧值意外开放无邀请码注册。

`GET /auth/config` 返回 `registration_mode: "admin"` 或 `"invite"`。账号页面根据该值展示注册入口。切换模式不改变已有账号、会话、空间或 Key；管理员建号与正常登录始终保留。邀请注册成功的账号没有管理员权限，也不会自动拥有历史租户或其他账号的空间。

## 管理员签发与撤销

在 `/account` 展开「管理员工具」，使用用户自己保存、对应该部署 Secret 的管理员 `API_KEY`。邀请码的签发、列表和撤销均需管理员 Key，普通账号会话、空间 Key 或邀请码不能调用这些接口。管理员 Key 每次操作后从输入框清除，不写入浏览器存储。

创建时填写名称、使用次数和可选到期时间：

- 默认允许注册 **1 个账号**；可设置 1–1000 次。每次成功注册消耗一次。
- 到期时间必须为未来时间；留空表示没有自动到期时间。UI 按设备时区显示，API 使用 Unix 毫秒整数。
- 完整邀请码仅在创建成功的响应和一次性窗口中显示。关闭窗口、退出、隐藏或离开页面后清除；列表只有识别前缀及状态，无法找回原文。遗失时撤销并重新签发。
- 撤销立即阻止后续兑换，不能恢复。撤销或到期不删除已注册账号，也不注销这些账号已建立的会话。
- 不把完整邀请码加入 URL、公开日志或仓库；它是允许注册的凭据。通过适当的私密渠道交给受邀人。

以下请求中的尖括号为占位符，不是真实凭据。

```http
POST /admin/invitations
Content-Type: application/json
X-Api-Key: <ADMIN_KEY>

{"label":"项目成员","max_uses":1,"expires_at":null}
```

创建响应包含 `{invitation, invitation_code}`。`invitation` 字段仅包含 `id`、`label`、`prefix`、`created_at`、`expires_at`、`max_uses`、`uses` 和 `revoked_at`；不会返回邀请码哈希或内部兑换凭证。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /admin/invitations` | 返回 `{invitations:[...]}`，仅非秘密元数据。 |
| `POST /admin/invitations` | 默认一次，可选未来到期时间；仅此响应返回完整 `invitation_code`。 |
| `DELETE /admin/invitations/:id` | 撤销指定邀请；重复撤销保持原撤销时间，未知 ID 返回 404。 |

管理员每小时最多尝试签发 30 次；同时有效、未撤销且未用完的邀请最多 100 个。超过速率返回 429 和 `Retry-After`，超过有效数量返回 409。可以撤销不用的邀请以释放有效数量额度；创建请求失败也计入尝试速率。

## 受邀人注册

邀请模式启用后，打开 `/account` 的邀请码注册入口，填写邀请码、邮箱、显示名称及至少 12 个字符的密码。成功后自动登录，再创建自己的记忆空间、选择记忆类型并签发空间 API Key。邀请码本身不能读写记忆。

```http
POST /auth/register
Content-Type: application/json
Origin: <SAME_ORIGIN>

{"email":"member@example.invalid","display_name":"成员","password":"<PASSWORD_AT_LEAST_12_CHARACTERS>","invitation_code":"<INVITATION_CODE>"}
```

成功返回 201 和账号信息，并设置 HttpOnly 会话 Cookie。缺失、格式错误、到期、已撤销、次数用完，或邮箱不能创建时，返回通用 400；模式关闭时返回 403。输入验证错误也不创建账号或消耗邀请码。请求体上限 16 KiB，同源/HTTPS 检查、密码哈希和登录安全规则与现有账号功能一致。

注册尝试限制为每 IP 每小时 5 次、每规范化邮箱每小时 3 次，超额返回 429。有效邀请码不会绕过这些限流。注册成功与失败的结果仍有区别，邀请持有者可能通过注册结果推断邮箱是否已使用；通用错误文字不能消除此差异。当前没有邮箱验证、密码找回或邮件发送流程。

## 原子消费与隔离

服务端只保存 SHA-256 邀请码哈希。邀请码由 Web Crypto 生成 32 随机字节，格式为 `wmi_` 加 64 位十六进制；识别前缀不是完整凭据。

注册先检查邀请码，完成密码派生后，在同一个 D1 `batch()` 事务里重新校验到期、撤销和剩余次数，再更新使用次数、插入账号并插入会话。最终到期判断使用 SQL 执行时的数据库时间。每次兑换的随机内部凭证将更新和账号插入绑定；兑换失败、重复邮箱或任何账号/会话 SQL 失败，整批回滚，无 Cookie，也不消耗次数。并发兑换不能超过 `max_uses`。限流尝试计数在独立事务中保留，避免失败请求绕过限制。

新账号初始没有空间。服务端沿用现有空间归属和 Scoped Key 授权：账号不能列出或管理其他账号空间，Key 不能跨空间读写、FTS 检索或 GC；历史未归属租户仍只能由管理员明确认领。

## 部署与后续维护

新数据库按 [Worker README](../walle-memory-worker/README.md#deploy-a-fresh-instance) 应用完整 migration 目录。已有数据库先核对实际 schema、绑定和 `d1_migrations` 历史，再应用缺失增量；手工初始化的 schema 不应直接重放完整目录。

[0002](../walle-memory-worker/migrations/0002_accounts_spaces_keys.sql) 引入账号、空间归属和 Scoped Key，保留旧租户、记忆、FTS 与旧 Key；[0003](../walle-memory-worker/migrations/0003_registration_invitations.sql) 的三条 DDL 仅增加邀请表和两个索引，不修改已有数据，也不预置邀请码。已存在的迁移不应重复执行。配置中的数据库 ID 是占位符，部署前须替换为自己的绑定。

通过支持的交互式 Secret 流程由用户设置管理员 `API_KEY`，再按需配置 `REGISTRATION_MODE=invite` 并发布。不要将 Key 放入普通变量、命令行参数、日志或仓库。监测密码派生 CPU、D1 限流和注册事务用量；公开存活检查不代替真实业务与认证负载验收。

紧急关闭可将模式改为 `admin` 或移除变量，后续注册即被拒绝；已存在账号与会话仍正常。保留新增表，不用删除数据作为回滚方式。回退曾支持 `public` 的旧版本前须审查其注册语义；选择识别现有账号、空间、Scope 和撤销状态的兼容 Worker。完整回滚限制见 [账号迁移指南](ACCOUNTS_AND_SPACES.md#6-d1-增量迁移与回滚限制)。

## 本地验证

`npm test` 在 Worker 目录进行类型检查、dry-run 构建和隔离 Miniflare/D1 测试，不发布资源。测试覆盖 hash-only 邀请码存储、到期/撤销、并发次数上限、重复邮箱与 SQL 失败回滚，以及注册账号空间隔离。可选浏览器邀请流程使用临时数据库和合成凭据；测试结束销毁，不连接生产服务。命令见 [验证指南](VALIDATION.md)，这里不预填本轮结果。
