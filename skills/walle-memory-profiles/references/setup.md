# 本机配置与秘密绑定

本 skill 不包含 API Key 或真实 profile，加载时不会创建配置、保存密钥或访问生产。安装 skill 与授权保存/持续访问某个空间 Key 是两个独立决定。

## 用户级安装

当前 [Codex 文档](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) 的用户级目录为 `~/.agents/skills`。从仓库根目录将 `skills/walle-memory-profiles` 复制到 `~/.agents/skills/walle-memory-profiles`，适用于该 macOS 用户的各项目。

先检查目标是否已存在；若存在，比较内容，不覆盖用户变更。不要同时安装到多个发现目录或覆盖旧实现。文件复制成功不等于既有会话已热加载；若新 skill 未出现在列表，重启 Codex。部分版本和本机工具仍使用 `~/.codex/skills`，应依据实际发现状态处理兼容链接，而不是复制多份。

其他 memory skill 如有重叠，可由用户在 `~/.codex/config.toml` 按精确 `SKILL.md` 路径禁用；不要擅自移除旧项，也不要从旧 skill 借用凭据。

## 非秘密 profile

配置默认在 `~/.config/walle-memory/profiles.json`，参照 [profiles.example.json](profiles.example.json)。alice/bob 是占位 alias，非实际账号。alias 长度 1–64，可用 Unicode 字母/数字/下划线、点和短横线，首字符不能是点或短横线；大小写严格匹配。

每个 alias 仅包含固定服务 origin 与 Keychain 引用：provider 为 `macos-keychain`，service 为 `xyz.dongdaxiang.walle-memory.space-key.v1`，account 精确为 `origin|alias`。不接受其他 profile 引用、默认用户、内联密钥、环境 Key、命令行 Key、秘密文件 fallback、未知 provider、重复 JSON 字段或其他来源。

用户名只是本机选择器；空间由 Key 决定。两个 alias 若误录同一个 Key，仍会操作同一空间。用户须核对每个 alias 的真实空间归属。缺用户名先要求指定；缺失或不可用凭据时停止，不尝试其他用户。

## macOS Keychain

通过 Apple [Keychain services](https://developer.apple.com/documentation/security/keychain-services) 的 Security/CoreFoundation API，以 Python ctypes 调用 SecItemAdd / SecItemCopyMatching；密钥不进入子进程参数或外部命令输出。

只查当前 macOS 用户 default classic/file-based Keychain（通常 login）内精确 service/account。新增仅 Add，重复绑定拒绝，无旧项读取、覆盖或删除；新增项关闭同步。读取禁止 UI，不自动解锁或同意授权；锁定、拒绝或缺失时失败，没有其他存储方式 fallback。

无 UI 通过 `SecKeychainSetUserInteractionAllowed(false)` 与锁定状态检查实现，开关作用于进程。使用独立 CLI，不要嵌入同时运行其他 Keychain 客户端的程序。经典 API 已弃用，当前 SDK/框架仍提供；真实项存取需在用户授权后验证。

保护边界是钥匙串锁定状态与 Python 可执行文件 ACL。它不保证 skill 独占、同 macOS 用户其他 Python 代码无法访问、屏幕锁定即不可读、每次生物识别或 Python 内存完全擦除。更强隔离须另行设计签名 helper/受支持秘密服务；不能擅自放宽 ACL 或启用全应用访问。

用户确认 alias 映射、存储与持续使用方案后，**用户亲自在自己的 Terminal 中运行**：

```sh
python3 <skill-dir>/scripts/enroll_key.py --user alice
```

程序要求交互终端、alias 确认、两次隐藏输入当前空间 Key；无 key 参数、文件、环境或 piped-stdin 保存方式，也不向服务端验证 Key。成功只显示 saved 与 alias。助手不得代运行保存或请用户在聊天发送 Key。既有绑定拒绝覆盖；轮换须由用户处理旧 Key 生命周期，本 skill 不提供自动删除/覆盖 Keychain 项流程。

本机 skill 不会自动注册成云端 MCP 工具。其他设备须能执行该 Mac 的本机任务；独立云端连接属于另一授权范围。
