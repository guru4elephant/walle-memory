---
name: walle-memory API
description: 旧兼容客户端的 Walle memory REST API 参考，说明 Node 租户 Key 与 Workers 空间 Key 的边界及共享记忆接口
type: reference
---

# walle-memory API 兼容参考

本文件保留为旧客户端的协议参考，以当前仓库实现为准。两个部署目标与安装说明见 [仓库 README](../../README.md)。所有路径均相对于自己的部署 origin；协议示例中的 Key 和 ID 均为占位符，不含可用凭据。

## 鉴权与部署目标

记忆 API 使用 `X-Api-Key`，由 Key 决定访问的租户或空间：

- Docker / Node SQLite：使用通过 `/admin/tenants` 签发的租户 Key。
- Cloudflare Workers / D1：使用 `/account` 签发的空间专用 Scoped Key；仍兼容未撤销的旧租户 Key。
- 服务端管理员 `API_KEY` 只授权 `/admin/` 管理接口，不用于日常记忆 CRUD、搜索或 summary。账号会话 Cookie 也不代替记忆 Key。

客户端不能通过 username、空间 ID 或记忆路径前缀切换到其他人的空间。Worker Scoped Key 的 `read`、`write`、`delete`、`gc` 分别授权下表操作；旧租户 Key 具有该租户的完整记忆权限。Worker Key 到期、撤销或所属账号禁用后不能继续使用，缺少所需 Scope 返回 403。不要改用其他用户或管理员 Key 绕过失败。

```http
GET /summary
X-Api-Key: <TENANT_OR_SPACE_KEY>
```

## 共享记忆 API

| 方法与路径 | Worker Scope | 行为 |
| --- | --- | --- |
| `GET /summary` | `read` | 当前租户或空间名称与全部存活条目的描述索引。 |
| `GET /memory` | `read` | 列出存活条目，可选 `?prefix=user/` 字面、区分大小写的前缀过滤。 |
| `GET /memory/search?q=...` | `read` | FTS5 搜索 key 和 description，最多 20 条；不搜索 value。 |
| `GET /memory/:key` | `read` | 读取完整条目并更新访问计数；不存在或已过期返回 404。 |
| `POST` / `PUT /memory/:key` | `write` | 新增或覆盖 `{value, description, ttl_seconds?}`。 |
| `DELETE /memory/:key` | `delete` | 删除条目；不存在返回 404。 |
| `POST /memory/gc` | `gc` | 仅删除当前租户或空间的已过期行。 |
| `GET /health` | 公开 | 返回 `{ "ok": true }`，仅检查存活。 |
| `GET /` | 公开页面 | 记忆 dashboard；浏览器自行提交记忆 Key。 |

`:key` 应作为一个 URL path component 完整编码。`GET /memory/search` 与 `POST /memory/gc` 有专用路由语义，避免将 `search` 或 `gc` 用作单段记忆 key。搜索表达式采用 FTS5 语法。

### Summary 与列表

`GET /summary` 返回 `{tenant, entries}`。以下只是响应结构示例，时间采用 Unix 毫秒，无到期时间为 `null`：

```json
{
  "tenant": "example-space",
  "entries": [
    {
      "key": "user/prefs/theme",
      "description": "用户主题偏好",
      "updated_at": 1730000000000,
      "expires_at": null
    }
  ]
}
```

`GET /memory` 将相同条目放在 `{ "keys": [...] }` 中。Summary 是数据库中的 key-description 索引，不调用 LLM；服务没有 `/summary/refresh` 接口或写入后触发模型生成的机制。描述索引可帮助客户端决定接下来读取哪个完整 value。

`GET /memory/search?q=...` 返回 `{ "results": [{ "key": "user/prefs/theme", "description": "用户主题偏好" }] }`。`GET /memory/:key` 返回 `key`、`tenant_id`、`value`、`description`、`access_count`、`last_accessed_at`、`updated_at`、`expires_at`。单条读取会增加访问计数，响应中的访问元数据是更新前的值。

### 写入、TTL 与删除

```http
PUT /memory/user%2Fprefs%2Ftheme
Content-Type: application/json
X-Api-Key: <TENANT_OR_SPACE_KEY>

{"value":"dark","description":"用户主题偏好","ttl_seconds":3600}
```

`value` 和 `description` 都是必需字符串。成功返回 `{ "ok": true, "key": "user/prefs/theme" }`。写入是 upsert，覆盖这两个字段；可选正数 `ttl_seconds` 设置到期，省略 TTL 会清除已有到期时间。过期条目在读取、列表、summary 和搜索中不可见，GC 后才物理删除。只改一个字段时，客户端需保留另一字段；到期时间也需明确处理。

单条删除成功返回 `{ "ok": true, "key": "<MEMORY_KEY>" }`。GC 成功返回 `{ "ok": true, "deleted": 0 }`，其中 `deleted` 是删除的基础记忆行数。删除和 GC 没有服务端确认 token、dry-run 或恢复接口，操作前确认目标租户或空间及用户意图。Worker 的输入边界、Scope 和事务重检细节见 [Worker 说明](../../walle-memory-worker/README.md)。

## Key 和 description 约定

使用 `namespace/topic/subtopic` 组织 key，例如 `user/prefs/theme`、`project/alpha/goal`、`context/work/current-task`。这些前缀不分配额外权限；同一空间的 `read` Key 可读取整个空间。

`description` 说明内容类型，例如“用户主题偏好，影响 UI 渲染”；`value` 保存实际内容，例如“dark”。客户端可先读取 summary 或搜索，再按需读取相关条目，并按用户明确意图保存值和描述。

## macOS profile 客户端

新的 [walle-memory-profiles skill](../../skills/walle-memory-profiles/SKILL.md) 按明确 `--user` 选择本机 profile，并使用对应 macOS Keychain 引用。其脚本只接受当前 `wmk_` 格式的 Workers 空间 Key，不支持旧租户 Key、管理员 Key，也不是 Node 旧客户端的替代安装包。

使用前按 [配置说明](../../skills/walle-memory-profiles/references/setup.md) 选择 alias 与空间映射，并由用户亲自进行已授权的隐藏录入。不要把真实 Key 写入本文件、命令行参数、普通配置、聊天或日志。安装本机 skill 不会自动建立秘密绑定或云端工具。
