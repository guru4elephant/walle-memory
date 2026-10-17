# MCP：OAuth 或空间 API Key

本指南说明 Workers 的 OAuth / API Key 二选一鉴权。实现与隔离测试概要见 [公开变更与验证摘要](PUBLIC_CHANGE_SUMMARY.md)。示例不包含真实凭据。

## 客户端只选一种

`POST https://memory.example.invalid/mcp` 使用 Streamable HTTP。每个实际请求选择下列一种鉴权，不能同时发送两个 Header：

| 模式 | 请求 Header | 授权范围 |
| --- | --- | --- |
| OAuth | `Authorization: Bearer <access-token>` | 原 OAuth 连接批准的空间及操作权限 |
| API Key | `X-Api-Key: <space-key>` | Key 绑定的单个空间及原有操作权限 |

API Key 直接复用 REST 的空间 Key 校验和 D1 事务内的授权检查。无需 OAuth 登录、注册客户端或刷新令牌。服务器仍要求有效的 `OAUTH_ISSUER`，用来固定规范服务 origin；生产现有配置可沿用，无新增环境变量、数据库迁移或依赖。

保留当前十个中文 MCP 工具及 MCP Apps 工作台。`workspace_id` 只能选本次连接有权访问的空间；API Key 无法切换到同账户的另一个空间。`memory_workspaces` 返回一个绑定空间及 `memory:…` 格式的有效权限，Key 原始 scope 仍为 `read/write/delete/gc`。前缀并不构成空间内的访问边界。

| Key scope | 可执行的工具 |
| --- | --- |
| `read` | `memory_list/get/search/summary/workspaces/workbench` |
| `write` | `memory_put/update` |
| `delete` | `memory_delete` |
| `gc` | `memory_gc` |

各 scope 独立，write/delete/gc 不隐含 read。建议 bot 使用独立空间和有到期时间的最小权限 scoped key。只有查看需求时授予 read；需要保存时再增加 write。未经明确需求不要授予 delete/gc。旧 legacy 空间 Key 为兼容保留其原有四类内存权限、单空间绑定及撤销规则；没有独立 scope 缩减和到期能力，不建议用于新 bot。

## bot 配置示例（全部为占位符）

下面是支持 `mcpServers`、HTTP URL 和自定义 Header 的客户端常见格式。字段名称以具体 bot 产品为准；`${WALLE_BOT_SPACE_KEY}` 表示客户端侧安全变量引用，服务端不负责插值，也不把它当作真实 Key。

```json
{
  "mcpServers": {
    "walle-memory": {
      "url": "https://memory.example.invalid/mcp",
      "headers": {
        "X-Api-Key": "${WALLE_BOT_SPACE_KEY}"
      }
    }
  }
}
```

若产品提供单独表单，选择 Streamable HTTP，填写上述 URL，并添加名称为 `X-Api-Key` 的安全 Header；关闭为这个连接自动添加 `Authorization` 的设置。只支持自动生成 Bearer Header、不能自定义 Header 的产品不兼容本 API Key 模式；不要把空间 Key 填入 OAuth token 字段。Key 不放进 URL、聊天内容、仓库或普通日志。

原 OAuth 客户端继续使用原连接及资源发现方式，无需增加 Key Header。OAuth 的工具 `_meta.securitySchemes` 保持原 oauth2 描述；API Key 请求返回 apiKey Header 描述，避免工具缺少 scope 时诱发无关 OAuth 登录。客户端是否展示这类元数据取决于宿主；真正的权限检查始终在服务端。

初次验证应使用专用隔离测试空间及虚构条目；不要拿 daily-work 或其他真实工作记忆测试第三方 bot。本次没有在实际 bot 中配置连接；生产服务已发布双鉴权版本，bot 的自定义 Header 能力仍需按产品核实。

## 拒绝及生命周期

- 同时收到 `Authorization` 和 `X-Api-Key`，即使其中一个无效、撤销或为空，也返回 HTTP 400；无凭据或单一无效凭据返回 401。重复同名 Header 合并后的值包含逗号会被拒绝。
- 按 Header 的存在与否选鉴权分支；OAuth 校验失败不会尝试 Key。`Bearer <space-key>`、`X-Api-Key: <OAuth-token>`、refresh token、Cookie、query 参数均不能替代相应凭据。
- 管理员 `API_KEY` 不参与 MCP Key 校验。普通空间 Key 也无法调用管理员接口。Key 账户停用、空间删除/转移、Key 到期/撤销后不能继续使用；scoped Key 的过期或撤销不会回退到 legacy 权限。
- 每次内存事务继续检查空间归属、scope、过期及撤销。请求开始后再失去权限的读写也会被拦截；先于撤销提交完成的操作不能倒转。
- Key 工具权限不足或事务内失权返回 MCP `isError`（HTTP 可为 200），不附 OAuth challenge；无凭据和 OAuth 失败保留原 OAuth 发现 challenge。客户端不能只靠 HTTP 200 判断工具成功。
- Key 的 MCP 与 REST 请求共享同一每分钟 300 次限流桶；切换接口不能绕过限流。OAuth 保留原限流方式。
- 原规范 Host、Origin 白名单和 no-store 响应保留，只在 MCP 预检允许 Header 中加入 `X-Api-Key`。OPTIONS 为不带鉴权的浏览器预检，不读取空间数据。若上游代理删除空 Header，应用只能按实际收到的 Header 判断；不能依赖空 Header 表达拒绝或授权意图。
- 可在原账户空间 Key 管理中撤销 Key，不删除记忆。OAuth 授权与空间 Key 各自独立撤销，撤销一种不自动撤销另一种。

## 发布前风险与恢复

部署后，已有有效空间 Key 也将能访问 `/mcp`，权限不会增加，但访问入口扩大。legacy Key 原有全内存权限同样可用，因此为 bot 配置前应选择独立、最小权限、有期限的 scoped key。具体 bot 是否支持自定义安全 Header 与 Streamable HTTP 尚需用隔离数据验收。

本改动只涉及 Worker 路由、MCP 适配、说明、测试。无 SQL 迁移、无新增 secret、无 Key 签发、无 REST 权限规则修改。正式发布前应再次核对生产版本和源包，防止覆盖新发布；必须保留生产的域名路由、D1 绑定、issuer、Origin 配置、注册模式、观测设置和秘密绑定。不要用源码中的占位 D1 配置直接发布。

回滚 Worker 到 上一个已验证的 Worker 版本 即恢复原 OAuth-only MCP；REST Key 仍按原规则可用，无数据迁移需要回滚。生产发布、真实 Key 签发/配置以及任何真实数据的第三方访问都需另行获得用户确认。
