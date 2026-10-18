---
name: cloud-mail-setup
description: 配置、验证、更新或排查 Fluma Cloud Mail MCP 的 stdio 接入、邮箱认证、写入开关和本地状态恢复。用于连接 mail.fluma.ai 或兼容 maillab/cloud-mail 的实例；日常邮件搜索、阅读、草稿和发送分别使用 cloud-mail-read、cloud-mail-send。
---

# Cloud Mail 接入配置

为 [cloud-mail-mcp](https://github.com/Fluma-Intelligence/cloud-mail-mcp) 配置本地 stdio 服务。前提是支持 stdio 的 MCP 客户端、Node.js 22.16+、npm 和已获授权的专用邮箱用户。Skill 提供工作流程；邮箱能力仍由 MCP 进程与邮箱角色提供。

## 确定接入目标

1. 从任务或现有客户端配置确定邮箱 origin、安装位置和用户；复用可用安装。缺失目标时只询问缺失项。
2. 先发现客户端中 Cloud Mail 的工具并调用 `mail_status {}`。本文使用工具短名，实际调用采用客户端公布的命名空间和参数 schema。已有连接且身份正确时直接验证所需能力。
3. 使用邮箱用户的 `MAIL_EMAIL` / `MAIL_PASSWORD`，或 `/api/login` 返回的原始用户 JWT `MAIL_TOKEN`。不要把平台管理员凭据或 Resend key 当成用户 JWT。凭据从本地私密文件或客户端密钥配置注入；缺失时要求安全配置，不让用户粘贴到聊天、issue 或仓库。

## 新安装

在用户指定的位置执行；目录已存在时先检查其内容与 Git 状态：

```bash
git clone https://github.com/Fluma-Intelligence/cloud-mail-mcp.git
cd cloud-mail-mcp
npm ci --ignore-scripts
npm run build
```

仅在 `.env` 不存在时从 `.env.example` 复制，并设为 `0600`；保留已有私密配置。配置要点：

| 配置 | 用法 |
|---|---|
| `MAIL_BASE_URL` | 应用的 HTTPS origin，例如 `https://mail.fluma.ai`；不带任意路径或查询参数 |
| `MAIL_EMAIL`、`MAIL_PASSWORD` | 专用邮箱用户登录；或使用 `MAIL_TOKEN` |
| `MAIL_TOKEN` | 原始用户 JWT，无 `Bearer ` 前缀 |
| `MAIL_ENABLE_WRITE` | 默认 `false`；获授权启用发送、回复、已读标记时设为 `true` 并重启 MCP |
| `MAIL_ALLOWED_RECIPIENTS` | 逗号分隔的完整地址白名单；也约束草稿。保留既有范围 |
| `MAIL_STATE_DIR` | 草稿和回执的私密绝对目录；默认 `~/.local/state/cloud-mail-mcp` |
| `MAIL_MAX_ATTACHMENT_BYTES` | 默认 1048576，最大 5242880；单次下载或一次发送全部附件的解码大小上限 |

邮箱角色需有 `account:query`；发信还需 `email:send`、可用发信域名、模式与额度。配置写入开关不会增加邮箱角色权限。

将以下 stdio 连接合并到客户端配置，保留其他连接。把路径替换为实际绝对路径；客户端若使用不同格式，按其配置规则转换这组 command/args：

```json
{
  "mcpServers": {
    "cloud-mail": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/cloud-mail-mcp/.env",
        "/absolute/path/to/cloud-mail-mcp/dist/index.js"
      ]
    }
  }
}
```

由客户端启动进程；`stdout` 是协议通道。安装 skill 不会自动创建 MCP 连接或提供邮箱密码。

## 验证与排查

1. 重新发现工具，调用 `mail_status`，核对 origin、email、accountId、permissions 和 mailboxWritesEnabled。
2. 调用 `list_mailboxes {"limit":1}`，随后 `list_messages {"limit":1}`。记录是否成功，不在公共结果中回显真实邮件正文。
3. 可在安装目录运行 `node --env-file=.env examples/smoke.mjs`；它只检查登录和读取。需要实际收发验收时，使用获授权的专用测试邮箱、收件人与合成正文，明确区分 API 受理和收件端实际收到。

| 现象 | 处理 |
|---|---|
| 无工具或进程退出 | 核对 Node 版本、绝对路径、构建产物和客户端 stderr，隐去凭据 |
| `CONFIG` | 检查 origin、认证变量和取值范围，不打印 `.env` |
| 401 / 403 或归属错误 | 核对用户、JWT 有效期和邮箱角色；不改用管理员身份绕过 |
| 缺少发送工具 | 检查写入开关及客户端是否已重启；默认 13 个工具，开启后 17 个 |
| `RECIPIENT_DENIED` / `SIZE_LIMIT` | 说明当前白名单或大小限制；不擅自放宽 |
| `SEND_UNCERTAIN` | 保留状态目录和 operationKey，按 cloud-mail-send 的回执核对流程处理 |

## 更新与恢复

1. 停止使用该安装的 MCP 客户端，私密备份 `.env` 与 `MAIL_STATE_DIR`，检查本地未提交修改。
2. 切换到用户所需 Git 版本，运行 `npm ci --ignore-scripts`、`npm run check`。
3. 使用相同 origin、用户和状态目录重启，验证 `mail_status`、草稿和已有发送回执。恢复备份也遵循同一身份映射。
4. `pending` 回执需先核对发件箱和获授权的服务商记录。删除状态、换目录或换 operationKey 会破坏重复发送防护。

交付时说明连接是否可用、已验证能力和仍缺失的条件。只读验证不等于真实收发验收。
