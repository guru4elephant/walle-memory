---
name: walle-memory API
description: walle-memory-server REST API 完整参考，包含所有 endpoint、字段说明、key 命名约定和使用模式
type: reference
---

# walle-memory API 参考

基础 URL：`http://localhost:3800`（或部署地址）

认证：若服务设置了 `API_KEY` 环境变量，每个请求需携带 `X-Api-Key: <key>` header。

---

## Endpoints

### GET /summary
返回当前 memory 索引，用于注入 agent system prompt。每次任务开始时调用一次。

```json
{ "index": "user/prefs → 用户界面偏好...\nproject/alpha → ..." }
```

### POST /summary/refresh
强制触发 LLM 重新生成索引（通常不需要手动调用，写入操作会自动触发）。

### GET /memory
列出所有 key 及其描述。可选 `?prefix=user/` 按 namespace 过滤。

```json
{
  "keys": [
    { "key": "user/prefs/theme", "description": "用户主题偏好", "updated_at": 1234567890 }
  ]
}
```

### GET /memory/search?q=\<query\>
全文搜索 key 和 description，返回最多 20 条匹配。当索引中没找到合适 key 时使用。

```json
{ "results": [{ "key": "user/prefs/theme", "description": "..." }] }
```

### GET /memory/:key
读取指定 key 的完整内容。

```json
{
  "key": "user/prefs/theme",
  "value": "dark",
  "description": "用户主题偏好，影响 UI 渲染",
  "access_count": 5,
  "last_accessed_at": 1234567890,
  "updated_at": 1234567890
}
```

返回 404 表示 key 不存在。

### POST /memory/:key
写入或更新一个 key。`value` 和 `description` 都是必填字符串。

```json
{
  "value": "dark",
  "description": "用户主题偏好，影响 UI 渲染"
}
```

成功返回 `{ "ok": true, "key": "user/prefs/theme" }`。

### DELETE /memory/:key
删除指定 key。返回 404 表示 key 不存在。

### GET /health
健康检查，返回 `{ "ok": true }`。

---

## Key 命名规范

格式：`namespace/topic/subtopic`（用 `/` 分隔层级）

| namespace | 用途示例 |
|-----------|---------|
| `user/`   | 用户偏好、配置、个人信息 |
| `project/<name>/` | 特定项目的目标、状态、截止日期 |
| `context/` | 当前工作上下文、最近记录 |
| `agent/<name>/` | 特定 agent 的私有状态 |

例：`user/prefs/theme`、`project/alpha/goal`、`context/work/last-standup`

---

## description 字段要求

`description` 是 memory 索引的基础，**不是内容的重复，而是说明这个 key 里装的是什么类型的信息**。

好的 description：`"用户主题偏好，影响 UI 渲染"`
差的 description：`"dark"`（这是 value，不是描述）

---

## 推荐使用模式

```
任务开始
  └── GET /summary               → 获取索引，了解有哪些 key
        └── 找到相关 key？
              ├── 是 → GET /memory/:key    → 读取具体内容
              └── 否 → GET /memory/search?q=<需要的信息>

存储重要信息
  └── POST /memory/:key  (value + description 必填)

任务结束，更新状态
  └── POST /memory/:key  更新相关 key
```
