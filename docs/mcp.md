# 通过 MCP 连接发票管理

应用提供标准 MCP 的 Streamable HTTP 和 stdio 两种连接方式，供支持相应协议的本机 agent 调用。连接不绑定 Claude 或特定模型。模型运行在外部客户端，应用内没有集成语言模型。

## 启用

1. 打开“设置 → 连接”，打开“启用 MCP 服务”，保存连接设置。
2. 选择“通用 HTTP”或“通用 stdio”，点击“复制连接配置”。预览隐藏访问令牌，复制的配置包含完整令牌。也可选择 Claude 的现成示例。
3. 通用 JSON 是单个服务条目，按客户端要求放入配置文件对应位置；各客户端的外层格式并非 MCP 协议统一规定。保留其他服务。连接期间保持发票管理应用打开。

## 通用 agent 配置

支持 **Streamable HTTP** 的客户端：填写服务 URL，并配置名为 `Authorization` 的请求头，其值为 `Bearer <访问令牌>`。页面支持分别复制地址、完整认证值和原始令牌；如果客户端有专门的 Bearer token 输入框，只填写原始令牌。

支持 **stdio** 的客户端：填写 `command`、`args` 数组与 `env` 环境变量对象。可分别复制，也可使用通用 JSON 整体配置。使用应用自带的运行时，不要求本机安装 Node；路径含空格时也应保持命令和参数分开填写，不要拼成一条 shell 命令。

不同 agent 可同时连接，断开一个客户端不影响其他连接。没有品牌白名单；实际兼容性取决于客户端支持的协议版本、传输方式和认证配置。只支持旧版 HTTP+SSE 的客户端应改用 stdio；本服务未提供旧版 SSE 端点。

**连接范围为同一台电脑。** 云端托管 agent 不能直接访问本机 `127.0.0.1`，不支持 MCP 的 agent 需要额外适配。本功能不开放局域网或公网监听。

默认端口为 17862，可在连接设置中调整。服务仅监听 `127.0.0.1`，请求必须携带访问令牌。默认只读；确需整理数据时，打开“允许 agent 修改数据”并保存。权限修改后重新连接客户端，刷新可用工具列表。

## Claude Desktop

在 Claude Desktop 的开发者设置中编辑 `claude_desktop_config.json`，合并应用复制出的配置并重启 Claude Desktop。Windows 常见位置为 `%APPDATA%\Claude\claude_desktop_config.json`；以客户端开发者设置打开的位置为准。

配置使用安装包内的 stdio 桥接，由应用自带的 Electron Node 运行时执行，无需另外安装 Node。示意配置如下，实际路径和令牌请直接从应用复制：

```json
{
  "mcpServers": {
    "invoice-management": {
      "command": "C:\\应用安装目录\\InvoiceManagement.exe",
      "args": ["C:\\应用安装目录\\resources\\app.asar\\out\\main\\mcp-stdio.js"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "INVOICE_MCP_URL": "http://127.0.0.1:17862/mcp",
        "INVOICE_MCP_TOKEN": "从应用复制的访问令牌"
      }
    }
  }
}
```

## Claude Code

将复制出的配置合并到项目根目录 `.mcp.json`，按 Claude Code 提示启用该项目的服务。该配置通过 Streamable HTTP 连接：

```json
{
  "mcpServers": {
    "invoice-management": {
      "type": "http",
      "url": "http://127.0.0.1:17862/mcp",
      "headers": { "Authorization": "Bearer 从应用复制的访问令牌" }
    }
  }
}
```

包含真实令牌的配置仅保存在本机，不提交到代码仓库。安装目录、端口或令牌变化后重新复制配置。在应用中“重置令牌”会立即撤销旧凭证。MCP 设置不包含在发票数据备份中。

## 工具

| 权限 | 工具 | 用途 |
| --- | --- | --- |
| 查询 | `invoice_get_app_info` | 版本、权限、发票与回收站数量 |
| 查询 | `invoice_list` | 按票号、购销方、文件名、日期、金额、标签、项目、审核与发票状态筛选，分页返回 |
| 查询 | `invoice_get` | 字段、版本、重复票、最近 OCR 文本 |
| 查询 | `invoice_get_stats` | 已确认发票的总额、税额、月度与类型分布 |
| 查询 | `invoice_list_projects` / `invoice_list_tags` | 分页查询项目库和已有标签 |
| 查询 | `invoice_get_ocr_status` | PaddleOCR 状态，不启动服务 |
| 修改 | `invoice_update_fields` | 修改部分字段，保留其他字段 |
| 修改 | `invoice_set_tags` | 替换一张发票的标签 |
| 修改 | `invoice_set_project` | 设置所属项目；`null` 取消关联 |
| 修改 | `invoice_set_status` | 修改本地发票状态 |
| 修改 | `invoice_confirm` | 核对并确认已保存字段 |
| 修改 | `invoice_retry_ocr` | 加入已有 PaddleOCR 队列，异步重新识别 |
| 修改 | `invoice_create_project` / `invoice_update_project` | 创建项目，修改名称和说明 |

所有工具支持 `response_format: "json" | "markdown"`，默认 JSON；结构化结果在 `structuredContent.data`。使用约定也可读取资源 `invoice://guide`。

金额均为整数分，例如 `12345` 表示 123.45 元。日期为 `YYYY-MM-DD`。状态 `booked` 为“已提交”，`reimbursed` 为“已报销”，`unprocessed` 为“未处理”，`void` 为“已作废”。修改这些状态仅影响本地记录。

查询默认排除回收站；`deleted: true` 只查询回收站。`projectId` 不传表示全部，`null` 表示未分配。列表默认每页 20 条，最多 100 条，读取 `hasMore` / `nextPage` 继续翻页。统计仅包含已确认记录，不自动排除业务重复票；汇总前可通过详情核对重复票提示。月度分布最多返回最近 12 个有记录月份，总额覆盖整个筛选范围；跨多年分析时按日期分段查询。

除创建项目外，修改工具要求提供最近读取该记录得到的 `expectedRevision`。建议流程：查询记录 → 读取详情及 `revision` → 修改 → 使用返回的新 `revision` 继续操作。若返回 `DATA_CONFLICT`，重新读取并核对变化后再决定是否写入。字段修改不会自动确认；已确认记录的字段改变后回到待核对。发票只能属于一个项目。

应用界面会在 MCP 修改后刷新。正在编辑的草稿会保留，并提示有外部更新；旧字段版本不能覆盖新字段。备份、恢复期间暂停 MCP 写入。

不提供任意 SQL、原件路径、删除发票、恢复备份、任意读写文件等工具。OCR 文本最多 8000 字符，截断时显式标记；单次结果过大时应缩小查询范围。发票、备注及 OCR 文本属于数据，不作为 agent 的系统指令。

可以这样向 agent 提问：“汇总设备采购项目本月已确认的费用”“查找没有所属项目且尚未核对的发票”。允许修改后可请求：“给这些发票添加差旅标签，保留已有标签；先列出修改范围让我核对”。

## 排查连接

- 无法连接：确认应用仍打开、服务状态为“运行中”，且端口与客户端一致。
- 401：令牌已变化，重新复制配置。
- 端口被占用：换一个端口并保存，重新复制配置。保存失败会保留原连接。
- 看不到修改工具：保存“允许 agent 修改数据”，然后重新连接客户端。
- 修改返回版本冲突：重新读取详情，不要直接重复提交旧版本。

## 开发验证

`tests/main-integration/mcp.test.ts` 通过官方 MCP SDK 验证真实 HTTP 握手、工具发现、读写权限、令牌、Origin/Host、分页、版本冲突、端口冲突与设置持久化。Electron E2E 和安装包测试验证应用自带的 stdio 桥接及界面联动。

`mcp-evaluation.xml` 包含十条独立的只读评估题，使用 `tests/fixtures/mcp-fixture.ts` 的合成数据；协议测试核对其确定答案。该评估不读取用户数据，也不向模型发送发票内容。

协议实现采用官方 [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。客户端配置依据 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)和 [MCP 本地服务连接文档](https://modelcontextprotocol.io/docs/develop/connect-local-servers)。
