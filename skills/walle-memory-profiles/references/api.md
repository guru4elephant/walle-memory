# 实际 Workers memory API

核对日期：2026-10-07。依据仓库 Workers 源码 [index.ts](../../../walle-memory-worker/src/index.ts)、[accounts.ts](../../../walle-memory-worker/src/accounts.ts)、[store.ts](../../../walle-memory-worker/src/store.ts) 与 [账号说明](../../../docs/ACCOUNTS_AND_SPACES.md)。来源见 [release provenance](../../../docs/RELEASE_PROVENANCE.md)。

Origin 固定为 `https://walle-memory.dongdaxiang.xyz`。鉴权为 `X-Api-Key`，不支持用户名、空间 ID 或账号 Cookie 选择记忆空间。当前签发空间 Key 格式为 `wmk_` 加 64 个小写十六进制字符；候选脚本仅支持该格式，不支持管理员 Key 与旧租户 Key。

| 方法与路径 | Scope | 字段与语义 |
| --- | --- | --- |
| `GET /memory?prefix=...` | read | `{keys:[{key,description,updated_at,expires_at}]}`；可省略 prefix；字面、区分大小写的前缀 |
| `GET /summary` | read | `{tenant,entries:[同 KeySummary]}`；tenant 为认证空间显示名；不是 LLM 生成摘要 |
| `GET /memory/search?q=...` | read | `{results:[{key,description}]}`；FTS5 搜索 key/description，最多 20 条；不是 value 向量搜索 |
| `GET /memory/:key` | read | `{key,tenant_id,value,description,access_count,last_accessed_at,updated_at,expires_at}`；缺失/过期为 404；会原子更新访问计数，但响应包含递增前元数据 |
| `POST` / `PUT /memory/:key` | write | 必需 JSON `value:string,description:string`；可选 `ttl_seconds`；返回 `{ok:true,key}`；upsert；省略 TTL 清除旧 expiry |
| `DELETE /memory/:key` | delete | `{ok:true,key}`；不存在为 404；允许删除已过期隐藏行 |
| `POST /memory/gc` | gc | `{ok:true,deleted}`；只删已过期行，deleted 是基础记录数 |

所有时间字段是 Unix 毫秒，无 expiry 为 null。Scoped Key 绑定一个空间及 owner account，验证撤销、过期、账号禁用与所需 scope；写入事务会再次校验。没有空间成员角色、单条记忆权限或路径前缀授权；同空间 read Key 可读整个空间，前缀只是组织约定。

body 最大 1 MiB；key/prefix 最大 1,024 UTF-8 字节；value 256 KiB、description 8 KiB，两个字符串可空但不能含 NUL；q 必需非空且不超过 2,048 字节。TTL 接受有限正数（可小数），到期毫秒必须可安全整数表示。错误 JSON `{error}`；401 表示无效/撤销/到期 Key 或账号禁用，403 表示 scope 不足；每 Key 300 次/分钟，429 附 `Retry-After`。候选不自动重试修改，也不显示原始错误 body。

服务端没有删除/GC 的确认 token、dry-run 或恢复接口。CLI 的 `--confirm-target` 只防止客户端选错目标。保留单段 key `search`、`gc`，另拒绝 URL dot segments `.`、`..`；其余路径做完整 percent encode。脚本选择 `PUT` 避免 POST 保留路由歧义，但保留 key 仍拒绝。

实现定位：`index.ts` 的 memory 路由；`accounts.ts` 的 `resolveMemoryAuth` 与 Key 签发；`store.ts` 的 `KeySummary`、`getEntry`、`upsert`、`deleteExpired`。所有空间选择都由认证结果决定。
