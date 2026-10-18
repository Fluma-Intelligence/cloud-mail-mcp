# Cloud Mail MCP

为 [maillab/cloud-mail](https://github.com/maillab/cloud-mail) 提供 MCP 接入。Agent 使用专用邮箱用户的 HTTPS API 权限列出、搜索和读取邮件，管理本地草稿，发送／回复邮件，获取附件及标记已读。

使用 TypeScript 与官方 MCP SDK v2，通过 **stdio** 运行。服务支持 SDK 提供的 2025 协议兼容入口及 2026-07-28 协议入口。

```text
Agent 的 MCP 客户端 → 本地 cloud-mail-mcp → 邮箱 HTTPS API
                          │                  └→ Worker → D1 / R2 / Resend
                          └→ 用户隔离的本地草稿和发送回执
```

## 安装与接入

需要 Node.js 22.16+（推荐使用部署环境已有的 Node.js 24）、npm，以及管理员创建的专用邮箱用户。

```bash
git clone https://github.com/Fluma-Intelligence/cloud-mail-mcp.git
cd cloud-mail-mcp
npm ci --ignore-scripts
npm run build
cp .env.example .env
chmod 600 .env
```

在本机编辑 `.env`：设置 `MAIL_BASE_URL` 为邮箱应用域名，例如 `https://mail.fluma.ai`，并配置专用用户的 `MAIL_EMAIL` / `MAIL_PASSWORD`。也可以只设置 `MAIL_TOKEN`，其值为 `/api/login` 返回的原始用户 JWT。

将 [examples/mcp.json](examples/mcp.json) 合并至支持 stdio 的 Agent 客户端配置，替换其中两处绝对路径：

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

由 MCP 客户端启动进程并管理其生命周期。`stdout` 专用于协议消息；启动错误写入 `stderr`。

可以先运行只读连通性检查，输出工具数量和检查结果：

```bash
node --env-file=.env examples/smoke.mjs
```

需要发送、回复或标记已读时，设置 `MAIL_ENABLE_WRITE=true` 后重启 MCP。管理员应为专用用户授予 `account:query`，发信时授予 `email:send`，并配置可用域名、发信模式和发送额度。

## 发信接入

MCP 发信工具包括 `send_message`（新邮件）、`send_draft`（发送本地草稿）和 `reply_message`（回复收件箱邮件），均支持附件。发件身份由当前用户的 `accountId` 决定，省略时使用主邮箱；其他发件地址的 ID 从 `list_mailboxes` 获取。

将 [examples/mcp-send.json](examples/mcp-send.json) 合并到 Agent 的 MCP 配置，替换安装路径。此配置通过 `env.MAIL_ENABLE_WRITE=true` 开启发信；同名的 `cloud-mail` 连接应更新原配置。重启连接后调用 `mail_status`，确认邮箱身份与 `mailboxWritesEnabled:true`，并重新发现上述工具。写入开关也会开放 `mark_read`；实际发信仍需邮箱角色的 `email:send` 权限与可用额度。

### 运行发送示例

完成上面的源码安装后，也可通过示例客户端调用同一套 MCP 发信工具。在私密 `.env` 中设置 `MAIL_ENABLE_WRITE=true`，然后准备发送请求：

```bash
cp examples/send-message.example.json send.private.json
chmod 600 send.private.json
```

在本机编辑 `send.private.json` 的收件人、主题、正文及附件，并将 `operationKey` 替换为本次发送的唯一标识，例如保存一次生成的 UUID。该文件包含真实邮件时保留在私密目录；仓库已忽略 `*.private.json`。

下面的命令会**立即发送**文件中的邮件，输出 API 受理回执：

```bash
node --env-file=.env examples/send.mjs send.private.json
```

`send.mjs` 也接受使用 `send_draft` 或 `reply_message` 的请求文件，参数见下文工具调用示例。附件 `content` 为标准 Base64；发送全部附件的解码总大小受 `MAIL_MAX_ATTACHMENT_BYTES` 限制。

按发送时保存的 `operationKey` 查询回执：

```bash
node --env-file=.env examples/send.mjs --status YOUR_SAVED_OPERATION_KEY
```

回执查询可在关闭写入时使用。`accepted` 表示 API 已受理；最终投递需在收件端确认。发送超时或 `pending` 时先核对回执与发件箱；保留同一 operationKey 和状态目录，按下文恢复流程处理。

## 配套 Skills

仓库附带三个可独立安装的技能，每个目录包含 `SKILL.md` 与 `agents/openai.yaml`。技能指导 Agent 使用现有 MCP 工具；安装后仍需按上节配置连接与邮箱凭据。

| Skill | 用途 | 调用示例 |
|---|---|---|
| [cloud-mail-setup](skills/cloud-mail-setup/SKILL.md) | 接入配置、权限检查、只读验证、更新与状态恢复 | `使用 $cloud-mail-setup 检查邮箱连接和可用权限。` |
| [cloud-mail-read](skills/cloud-mail-read/SKILL.md) | 邮箱选择、分页搜索、正文摘要、附件、按需标记已读 | `使用 $cloud-mail-read 搜索主题含“合同”的邮件，并说明搜索范围。` |
| [cloud-mail-send](skills/cloud-mail-send/SKILL.md) | 本地草稿、附件发送、线程回复、回执核对 | `使用 $cloud-mail-send 给指定收件人创建会议确认草稿。` |

### Multica 工作区

导入每个技能目录；默认遇到同名技能会报冲突，避免覆盖已有配置：

```bash
for skill in cloud-mail-setup cloud-mail-read cloud-mail-send; do
  multica skill import \
    --url "https://github.com/Fluma-Intelligence/cloud-mail-mcp/tree/main/skills/$skill" \
    --output json || break
done
```

导入成功后，技能出现在工作区技能库。需要指定 Agent 使用时，在其配置中添加技能并配置 MCP；也可使用 `multica agent skills add <agent-id> --skill-ids <skill-id>`，再以 `multica agent skills list <agent-id> --output json` 验证。ID 使用导入结果和 Agent 查询返回的实际值；`add` 保留已有技能。

### 本机 Codex

在仓库根目录执行以下命令，将完整技能目录复制到个人技能目录；已存在的同名目录会跳过：

```bash
mkdir -p "$HOME/.agents/skills"
for skill in cloud-mail-setup cloud-mail-read cloud-mail-send; do
  if [ -e "$HOME/.agents/skills/$skill" ]; then
    printf '已存在，跳过：%s\n' "$skill"
  else
    cp -R "skills/$skill" "$HOME/.agents/skills/"
  fi
done
```

重新打开会话，确认技能出现在可用技能列表。团队也可放到目标项目的 `.agents/skills/`；目录规则见 [官方技能文档](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)。其他支持 `SKILL.md` 的客户端按其安装规则导入完整目录。

技能包含搜索未完成时的续查、草稿版本冲突、回复线程及发送结果不确定时的处理。已读标记和发送遵循用户任务授权；邮件与附件内容按外部数据处理。

## 配置

| 参数 | 用途 | 默认值 |
|---|---|---|
| `MAIL_BASE_URL` | 邮箱应用 HTTPS origin；接受末尾 `/api` | 必填 |
| `MAIL_EMAIL`、`MAIL_PASSWORD` | 专用用户登录 | 与 `MAIL_TOKEN` 二选一 |
| `MAIL_TOKEN` | 原始用户 JWT；同时提供密码时可在读取遇到会话失效后重新登录 | 空 |
| `MAIL_ENABLE_WRITE` | 暴露发信、回复、发送草稿和已读标记工具 | `false` |
| `MAIL_ALLOWED_RECIPIENTS` | 允许发送的完整邮箱地址，逗号分隔；空值使用邮箱角色允许的范围 | 空 |
| `MAIL_STATE_DIR` | 本地草稿、发送回执根目录；使用绝对路径便于备份 | `~/.local/state/cloud-mail-mcp` |
| `MAIL_TIMEOUT_MS` | 单次邮箱请求超时，100–120000 ms | `15000` |
| `MAIL_MAX_ATTACHMENT_BYTES` | 单个下载、一次发送全部附件的解码大小上限，最多 5 MiB | `1048576` |

服务只接受配置的邮箱 origin。HTTP 限于 loopback 本地测试；凭据请求和附件下载均不跟随重定向。

## 工具

默认提供 13 个工具，开启邮箱写入后共 17 个。

| 工具 | 功能与主要参数 |
|---|---|
| `mail_status` | 当前邮箱身份、权限、写入开关和附件上限 |
| `list_mailboxes` | 列出当前用户的邮箱；使用返回的 `nextCursor` 续页 |
| `list_messages` | `accountId?`、`folder`、`beforeId`、`limit`；返回摘要与 `nextBeforeId` |
| `get_message` | `accountId?`、`emailId`、`folder`；返回正文，不改变已读状态 |
| `search_messages` | `query`、`field`、`maxPages`、`maxResults`、`beforeId`；返回搜索范围与续查游标 |
| `list_attachments` | 指定邮件的附件元数据 |
| `download_attachment` | 指定邮件与 `attachmentId`，返回 Base64 内容 |
| `create_draft` | 保存当前用户的本地草稿，支持附件 |
| `list_drafts` | 本地草稿摘要 |
| `get_draft` | 按 `draftId` 读取草稿 |
| `update_draft` | 使用当前 `revision` 和完整 `message` 替换草稿 |
| `delete_draft` | 使用 `draftId` 和当前 `revision` 删除草稿 |
| `get_send_status` | 根据 `operationKey` 读取本地发送回执 |
| `send_message` | **写入**：立即发送邮件，必须提供 `operationKey` |
| `reply_message` | **写入**：回复收件箱邮件的发件人，保留上游线程关联 |
| `send_draft` | **写入**：发送指定草稿版本，保留本地草稿 |
| `mark_read` | **写入**：对当前邮箱内的 `emailIds` 批量标记已读 |

`accountId` 缺省使用当前用户主邮箱；`folder` 为 `inbox` 或 `sent`，缺省 `inbox`。所有邮件列表固定限制到所选邮箱。对其他用户的账号、邮件、附件的请求会被拒绝。

搜索使用普通用户的分页接口，在 MCP 内匹配主题、发件人、收件人及正文。每页至多 50 封，默认最多 5 页。`exhausted=false` 表示结果未覆盖全部剩余邮件；继续传入 `nextBeforeId`，直至 `exhausted=true`。正文搜索含原始 HTML。

读取单封邮件使用上游“严格小于 emailId”的游标规则定位，并核对返回 ID、用户和邮箱归属。正文文本和 HTML 各最多返回 100000 字符，超过时 `bodyTruncated=true`。

## 调用示例

以下对象可传给 MCP 客户端的 `callTool`。SDK 的完整只读调用示例见 [examples/smoke.mjs](examples/smoke.mjs)。

列出最近邮件：

```json
{"name":"list_messages","arguments":{"folder":"inbox","limit":20}}
```

搜索主题并读取结果中的邮件 ID：

```json
{"name":"search_messages","arguments":{"query":"项目进度","field":"subject","maxPages":5}}
```

```json
{"name":"get_message","arguments":{"emailId":123,"folder":"inbox"}}
```

保存带有合成附件的草稿：

```json
{
  "name":"create_draft",
  "arguments":{
    "to":["test-recipient@example.com"],
    "subject":"MCP 验证",
    "text":"这是一封测试邮件。",
    "attachments":[{"filename":"hello.txt","type":"text/plain","content":"aGVsbG8="}]
  }
}
```

发送草稿时，使用返回的 `id` 与 `revision`：

```json
{"name":"send_draft","arguments":{"draftId":"00000000-0000-4000-8000-000000000000","revision":1,"operationKey":"mail-test-001"}}
```

直接发送与回复：

```json
{"name":"send_message","arguments":{"to":["test-recipient@example.com"],"subject":"测试","text":"测试内容","operationKey":"mail-test-002"}}
```

```json
{"name":"reply_message","arguments":{"emailId":123,"text":"已收到。","operationKey":"mail-reply-001"}}
```

附件与已读标记：

```json
{"name":"list_attachments","arguments":{"emailId":123}}
```

```json
{"name":"download_attachment","arguments":{"emailId":123,"attachmentId":7}}
```

```json
{"name":"mark_read","arguments":{"emailIds":[123]}}
```

所有示例地址和 ID 都是占位值；执行发送示例前使用实际获授权的测试收件人和查询返回的 ID。

## 发送回执与恢复

`operationKey` 标识一封具体邮件的发送意图。同一个 key、同样内容的重试在已有成功回执时返回该回执；同 key 改变内容会被拒绝。此保护在共享同一状态目录的 MCP 进程之间生效。

发送前先原子创建 `pending` 记录，发送成功后保存 `accepted` 回执。连接断开、超时或进程异常可能留下 `pending`：此时工具返回 `SEND_UNCERTAIN`，并阻止再次发送。通过 `get_send_status` 查询，结合邮箱发件箱与服务商投递记录核实后再决定下一步。`accepted` 表示邮箱 API 受理，`deliveryConfirmed=false` 表示尚未验证最终投递。

更新与恢复步骤：

1. 关闭使用该安装目录的 MCP 客户端，备份 `.env` 和 `MAIL_STATE_DIR`。
2. 切换到所需 Git 版本，执行 `npm ci --ignore-scripts` 与 `npm run check`。
3. 保留原状态目录，重启客户端并调用 `mail_status`。
4. 恢复时使用同一邮箱 origin 和用户，恢复其状态目录；核对 `pending` 回执后再恢复发送。

草稿更新使用版本号防止覆盖其他编辑。若进程在编辑时异常退出留下 `.lock` 文件，维护者确认所有相关进程已停止并备份目录后，可删除对应锁文件；发送回执应保留用于核对。

## 开发与验证

```bash
npm run check
npm pack --dry-run
```

集成测试启动真实 MCP 子进程，使用官方客户端进行握手、工具发现与调用，并连接本地模拟邮箱 HTTP 服务。测试覆盖两代协议入口、JWT／密码认证、分页搜索、归属校验、附件限制、草稿持久化和版本冲突、发送／回复、并发与重启后的重复发送防护、结果不确定时的处理、已读标记和业务错误。

源码契约基于上游 [ec7a2bb 版本](https://github.com/maillab/cloud-mail/tree/ec7a2bb17c950576c38d7308128cac7696fea169)。持续集成在 Node.js 22 和 24 上执行构建与测试。

代码入口：`src/client.ts` 为邮箱 API 适配，`src/server.ts` 为 MCP 工具，`src/store.ts` 为本地草稿与回执，`src/config.ts` 为配置。

## 边界与安全

- 本版本为单个邮箱用户的本地 stdio 服务。远程 HTTP 托管、调用者登录与多租户身份映射属于后续扩展。
- 草稿属于本地 MCP 状态，不会出现在 cloud-mail 网页草稿箱。草稿目前要求至少一个收件人和正文；跨端共享草稿需要后端能力。
- 搜索是受限分页扫描；标记未读、回复全部和按任意服务商 URL 下载附件暂未提供。
- 当前测试使用合成邮件和模拟服务，真实 Cloudflare／Resend 环境的收发与附件链路需使用专用测试邮箱验收。`examples/smoke.mjs` 只验证登录和读取接口。
- 上游 API 缺少端到端幂等键。不同状态目录、丢失回执、手工更换操作标识或底层存储故障仍可能造成重复投递；无法承诺服务商层面的 exactly-once。
- 凭据由环境变量或本地私密文件注入，不经工具参数传递。草稿含正文与附件，回执含邮件标识；数据文件默认 `0600`、用户目录 `0700`，状态目录与备份按邮箱数据保护。权限、配额仍由邮箱角色控制。
- MCP 返回的邮件和附件是外部数据。发送需属于用户授权的任务范围；客户端应按工具的写入标注和自身权限策略执行。

## 许可证

MIT，见 [LICENSE](LICENSE)。MCP SDK 文档见 [官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。
