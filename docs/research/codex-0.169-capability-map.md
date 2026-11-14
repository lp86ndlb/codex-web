# Codex 0.169.0 原生能力与 cweb 对照

核对日期：2026-11-14。本机已安装 CLI：`0.169.0`；cweb 源码基线：`bac1f56`。这是源码与 schema 静态核对，不是对运行中的 daemon 做全接口调用测试。

与面向产品的 [120 项功能清单](2026-11-14-agent-ui-survey.md)配套阅读。实施时应重新核对目标版本。

## 1. 证据与读法

本次只运行版本、帮助和 schema 导出；没有调用模型、执行压缩、切换账户、启动登录、重启 daemon 或试运行有副作用的接口。导出放在已忽略的缓存目录，公共仓库只保存本对照文档。

```bash
codex --version
codex app-server generate-json-schema --out .cache/capability-survey-2026-11-14/protocol-stable
codex app-server generate-json-schema --experimental --out .cache/capability-survey-2026-11-14/protocol-experimental
codex doctor --help
```

目录名中的 `protocol-stable` 只是本次命名，不是稳定性保证。

- **常规导出**：默认 schema 包含的方法，共 **109** 个。
- **实验增量**：加 `--experimental` 才导出的方法，共 **75** 个；合计 **184**。
- **已接 RPC**：找到明确调用路径，本次共核对 **25** 个；不表示每条路径在本机账户和当前运行端都成功。
- **本地适配**：已有相关网页能力，但没有调用表中的原生方法；不能计作原生接口覆盖。
- **未接**：当前桥接未发现对应明确调用；可能值得新增，也可能是内部、平台或特殊账户接口。
- 默认导出不等于承诺稳定；实验开关打开也不代表全部方法可用。
- 一个用户功能可能需要多个请求、通知与 server request，也可能走本地 Git/文件适配。不能以 25/184 计算产品完成度。

[官方 App Server 说明](https://learn.chatgpt.com/docs/app-server)用于理解集成模型；实际方法名以本机生成的 `ClientRequest.json`、`ServerRequest.json` 和 `ServerNotification.json` 为准。源码证据：[bridge.ts](../../bridge/server/bridge.ts)、[rpc.ts](../../bridge/server/rpc.ts)、[preferences.ts](../../bridge/server/preferences.ts)、[http.ts](../../bridge/server/http.ts)。

## 2. 184 个客户端请求

表中的建议尚未实施。“未接”不要求新增对应按钮。未单列备注的条目，需按所在组的约束、实际参数/返回值继续设计。

### 连接、诊断与宿主验证（8）

诊断可放设置；验证流程需独立适配，内部方法不做普通按钮。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `initialize` | 常规导出 | 已接 RPC | 连接初始化；尚需完善运行端版本与能力展示 |
| `server/diagnostics` | 实验增量 | 未接 | 进程和 gauges；不能代替 Provider 网络诊断 |
| `userVerification/status` | 实验增量 | 未接 | 按本组约束评估 |
| `userVerification/enroll` | 实验增量 | 未接 | 按本组约束评估 |
| `userVerification/delete` | 实验增量 | 未接 | 按本组约束评估 |
| `userVerification/verify` | 实验增量 | 未接 | 按本组约束评估 |
| `userVerification/cancel` | 实验增量 | 未接 | 按本组约束评估 |
| `mock/experimentalMethod` | 实验增量 | 未接 | 测试接口，不进入产品界面 |

### 目标（3）

复用 GoalPanel；保持用户目标和状态语义。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `thread/goal/set` | 常规导出 | 已接 RPC | 创建/编辑目标及状态 |
| `thread/goal/get` | 常规导出 | 已接 RPC | 读取当前目标 |
| `thread/goal/clear` | 常规导出 | 已接 RPC | 清除目标不等于完成任务 |

### 原生队列（6）

原生队列为实验增量；与网页内存队列只能有一个执行真值，避免双重发送。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `thread/queue/add` | 实验增量 | 本地适配 | 当前只有网页进程内存队列 |
| `thread/queue/list` | 实验增量 | 本地适配 | 当前只有网页队列列表 |
| `thread/queue/update` | 实验增量 | 未接 | 补原生队列编辑 |
| `thread/queue/delete` | 实验增量 | 本地适配 | 当前只有网页队列移除 |
| `thread/queue/reorder` | 实验增量 | 未接 | 补原生队列重排与跨端同步 |
| `thread/queue/start` | 实验增量 | 本地适配 | 已有网页排队执行；接原生后避免重复发送 |

### 上下文与记忆（6）

复用上下文环；区分压缩、记忆摘要与历史记录。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `thread/memoryMode/set` | 实验增量 | 未接 | 记忆模式与作用范围说明 |
| `thread/memory/read` | 实验增量 | 未接 | 查看原生摘要；允许为空，不补造记忆 |
| `memory/status` | 实验增量 | 未接 | 记忆状态与 token 用量分开 |
| `memory/reset` | 实验增量 | 未接 | 明确影响范围，不作常规缓存清理 |
| `rollout/compress` | 实验增量 | 未接 | 内部 rollout 压缩；不替代 /compact |
| `thread/compact/start` | 常规导出 | 已接 RPC | 已接原生压缩、锁与完成核对 |

### 实时会话与语音（7）

需另接音频宿主、采集权限和资源生命周期，按实际运行端能力提供。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `thread/realtime/start` | 实验增量 | 未接 | 按本组约束评估 |
| `thread/realtime/appendAudio` | 实验增量 | 未接 | 按本组约束评估 |
| `thread/realtime/appendText` | 实验增量 | 未接 | 按本组约束评估 |
| `thread/realtime/appendSpeech` | 实验增量 | 未接 | 按本组约束评估 |
| `thread/realtime/stop` | 实验增量 | 未接 | 按本组约束评估 |
| `thread/timeline/list` | 实验增量 | 未接 | 按本组约束评估 |
| `thread/realtime/listVoices` | 实验增量 | 未接 | 按本组约束评估 |

### 终端与进程（12）

独立命令、会话后台终端、底层进程是不同生命周期；操作要绑定所有权。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `thread/shellCommand` | 常规导出 | 未接 | 会话内命令候选；核对审批与输出语义 |
| `thread/backgroundTerminals/clean` | 实验增量 | 未接 | 清理前显示具体受影响对象 |
| `thread/backgroundTerminals/list` | 实验增量 | 未接 | 查看指定会话后台终端 |
| `thread/backgroundTerminals/terminate` | 实验增量 | 未接 | 停止指定后台终端，不全局 kill |
| `command/exec` | 常规导出 | 未接 | 独立命令执行；保留原生 sandbox 约束 |
| `command/exec/write` | 常规导出 | 未接 | 向已授权的指定命令写输入 |
| `command/exec/terminate` | 常规导出 | 未接 | 停止指定命令，核对 processId |
| `command/exec/resize` | 常规导出 | 未接 | 尺寸与终端组件同步 |
| `process/spawn` | 实验增量 | 未接 | 实验底层进程宿主；优先评估 command/exec |
| `process/writeStdin` | 实验增量 | 未接 | 按本组约束评估 |
| `process/kill` | 实验增量 | 未接 | 不能作为单话题失败时的全局杀进程入口 |
| `process/resizePty` | 实验增量 | 未接 | 按本组约束评估 |

### 项目与原生分组（12）

与 cweb 工作区目录分开；先验证原生对象含义和迁移，不直接替换侧栏。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `thread/section/move` | 常规导出 | 未接 | 按本组约束评估 |
| `project/list` | 实验增量 | 未接 | 按本组约束评估 |
| `project/read` | 实验增量 | 未接 | 按本组约束评估 |
| `project/create` | 实验增量 | 未接 | 按本组约束评估 |
| `project/import` | 实验增量 | 未接 | 按本组约束评估 |
| `project/update` | 实验增量 | 未接 | 按本组约束评估 |
| `project/move` | 实验增量 | 未接 | 核对移动对象是目录还是元数据 |
| `project/delete` | 实验增量 | 未接 | 核对文件是否受影响，不只凭方法名判断 |
| `threadSection/list` | 常规导出 | 未接 | 按本组约束评估 |
| `threadSection/create` | 常规导出 | 未接 | 按本组约束评估 |
| `threadSection/update` | 常规导出 | 未接 | 按本组约束评估 |
| `threadSection/delete` | 常规导出 | 未接 | 按本组约束评估 |

### 会话、轮次与审查（38）

继续使用原生会话；分支、回退、归档、删除各自说明范围。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `thread/start` | 常规导出 | 已接 RPC | 新建；保留工作区、权限和动态工具配置 |
| `thread/resume` | 常规导出 | 已接 RPC | 恢复；核对正在执行轮次及所属客户端 |
| `thread/fork` | 常规导出 | 未接 | 分支；核对 beforeTurnId / lastTurnId 边界，文件仍共享 |
| `thread/sample` | 实验增量 | 未接 | 采样类实验候选；先核对用途，不作普通运行按钮 |
| `thread/sample/cancel` | 实验增量 | 未接 | 只处理对应采样生命周期 |
| `thread/archive` | 常规导出 | 已接 RPC | 按本组约束评估 |
| `thread/delete` | 常规导出 | 未接 | 删除前解释原生记录及附件处理范围 |
| `thread/unsubscribe` | 常规导出 | 已接 RPC | 脱离订阅不等于终止任务 |
| `thread/increment_elicitation` | 实验增量 | 未接 | 内部交互计数，不单独做按钮 |
| `thread/decrement_elicitation` | 实验增量 | 未接 | 内部交互计数，不单独做按钮 |
| `thread/name/set` | 常规导出 | 已接 RPC | 按本组约束评估 |
| `thread/prediction/request` | 实验增量 | 未接 | 预测类实验接口；不作普通回复入口 |
| `thread/metadata/update` | 常规导出 | 未接 | 仅写支持的字段，不假设可塞入任意网页状态 |
| `thread/attachment/add` | 常规导出 | 未接 | 按本组约束评估 |
| `thread/attachment/list` | 常规导出 | 未接 | 按本组约束评估 |
| `thread/attachmentOwner/list` | 常规导出 | 未接 | 按本组约束评估 |
| `thread/attachment/remove` | 常规导出 | 未接 | 按本组约束评估 |
| `thread/settings/update` | 实验增量 | 未接 | 按本组约束评估 |
| `thread/unarchive` | 常规导出 | 已接 RPC | 按本组约束评估 |
| `thread/approveGuardianDeniedAction` | 常规导出 | 未接 | 特定原生审批流程，不能用来绕过策略 |
| `thread/revert` | 常规导出 | 已接 RPC | 历史编辑回退；不撤销项目文件 |
| `thread/list` | 常规导出 | 已接 RPC | 原生会话与归档列表 |
| `thread/search` | 实验增量 | 未接 | 原生搜索；缺支持时考虑受限本地索引 |
| `thread/searchOccurrences` | 实验增量 | 未接 | 命中定位；仅加载目标附近历史 |
| `thread/loaded/list` | 常规导出 | 未接 | 用于已加载会话核对；不等于全部运行中任务 |
| `thread/read` | 常规导出 | 已接 RPC | 读取状态和历史；控制全量历史负载 |
| `thread/readState/update` | 实验增量 | 未接 | 核对跨端语义后再替换网页已读记录 |
| `thread/turns/list` | 常规导出 | 已接 RPC | 已用于历史与核对；尚需端到端分页 |
| `thread/items/list` | 常规导出 | 未接 | 条目分页，详情按需加载 |
| `thread/items/read` | 实验增量 | 未接 | 指定条目读取，长输出懒加载 |
| `thread/guardianReview` | 实验增量 | 未接 | 策略审查；与代码 review 分开 |
| `thread/inject_items` | 常规导出 | 已接 RPC | 桥接内部上下文注入；不暴露任意角色编辑器 |
| `thread/prepareApprovedPlan` | 实验增量 | 未接 | 先核对计划批准流程和模式支持 |
| `turn/start` | 常规导出 | 已接 RPC | 补持久消息标识与结果未知核对 |
| `turn/settings/update` | 实验增量 | 未接 | 按本组约束评估 |
| `turn/steer` | 常规导出 | 已接 RPC | 绑定当前轮次，避免进入错误任务 |
| `turn/interrupt` | 常规导出 | 已接 RPC | 停止指定轮次，不杀共享引擎 |
| `review/start` | 常规导出 | 未接 | 原生代码审查；选择实际支持的目标 |

### Skills 与 Hooks（4）

复用 Skills 页；显示来源、作用范围与生效时机。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `skills/list` | 常规导出 | 已接 RPC | 已接列表与设置 |
| `skills/extraRoots/set` | 常规导出 | 未接 | 额外搜索根需明确范围和生效时机 |
| `hooks/list` | 常规导出 | 未接 | 查看来源与状态；不以测试为由自动执行 |
| `skills/config/write` | 常规导出 | 本地适配 | 当前使用 cweb 偏好和会话 config 覆盖 |

### 插件、市场与 Apps（19）

设置中分类管理；安装、授权、共享和卸载不是一个操作，按来源与实际权限适配。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `marketplace/add` | 常规导出 | 未接 | 按本组约束评估 |
| `marketplace/remove` | 常规导出 | 未接 | 按本组约束评估 |
| `marketplace/upgrade` | 常规导出 | 未接 | 按实现确认升级对象和重载范围 |
| `plugin/list` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/search` | 实验增量 | 未接 | 按本组约束评估 |
| `plugin/installed` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/reconcile` | 常规导出 | 未接 | 核对是否会修改本地安装 |
| `plugin/read` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/skill/read` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/share/save` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/share/updateTargets` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/share/list` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/share/checkout` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/share/delete` | 常规导出 | 未接 | 按本组约束评估 |
| `app/read` | 常规导出 | 未接 | 按本组约束评估 |
| `app/list` | 常规导出 | 未接 | 按本组约束评估 |
| `app/installed` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/install` | 常规导出 | 未接 | 按本组约束评估 |
| `plugin/uninstall` | 常规导出 | 未接 | 按本组约束评估 |

### 文件与搜索（13）

优先保留已有路径约束和文件 API；写入/删除不能暴露为任意 RPC 代理。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `fs/readFile` | 常规导出 | 本地适配 | 已有专用文件预览 API，不是此原生 RPC |
| `fs/writeFile` | 常规导出 | 未接 | 文件编辑候选；版本冲突与工作区校验 |
| `fs/createDirectory` | 常规导出 | 未接 | 按本组约束评估 |
| `fs/getMetadata` | 常规导出 | 本地适配 | 已有本地文件信息适配 |
| `fs/readDirectory` | 常规导出 | 本地适配 | 已有工作区浏览适配 |
| `fs/remove` | 常规导出 | 未接 | 文件删除候选；先显示范围 |
| `fs/copy` | 常规导出 | 未接 | 按本组约束评估 |
| `fs/watch` | 常规导出 | 未接 | 按面板生命周期订阅 |
| `fs/unwatch` | 常规导出 | 未接 | 关闭面板及时释放订阅 |
| `fuzzyFileSearch` | 常规导出 | 本地适配 | 已有本地文件引用搜索 |
| `fuzzyFileSearch/sessionStart` | 实验增量 | 未接 | 按本组约束评估 |
| `fuzzyFileSearch/sessionUpdate` | 实验增量 | 未接 | 按本组约束评估 |
| `fuzzyFileSearch/sessionStop` | 实验增量 | 未接 | 按本组约束评估 |

### 模型、模式与权限（8）

扩展设置；默认值、会话值、权限策略与账户可用性分别显示。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `model/list` | 常规导出 | 已接 RPC | 已有模型与强度选项 |
| `modelProvider/list` | 常规导出 | 未接 | 按本组约束评估 |
| `modelProvider/config/write` | 常规导出 | 未接 | 按本组约束评估 |
| `modelProvider/capabilities/read` | 常规导出 | 未接 | 本版只含图像生成和网页搜索字段 |
| `experimentalFeature/list` | 常规导出 | 未接 | 按本组约束评估 |
| `permissionProfile/list` | 常规导出 | 未接 | 显示权限 Profile 与策略约束 |
| `experimentalFeature/enablement/set` | 常规导出 | 未接 | 显式启停，说明生效范围 |
| `collaborationMode/list` | 实验增量 | 已接 RPC | 已接 Plan/默认模式；本版仍属实验增量 |

### MCP（7）

完整服务面板、OAuth、资源和交互需一起适配；不自动执行有副作用工具来检测。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `mcpServer/oauth/login` | 常规导出 | 未接 | 原生 OAuth 及完成核对 |
| `config/mcpServer/reload` | 常规导出 | 未接 | 显示重载对当前工具的影响 |
| `mcpServerStatus/list` | 常规导出 | 已接 RPC | 当前主要用于 Todo MCP 检查 |
| `mcpServer/resource/read` | 常规导出 | 未接 | 按需读取资源 |
| `mcpServer/event/stream/start` | 实验增量 | 未接 | 按本组约束评估 |
| `mcpServer/event/stream/stop` | 实验增量 | 未接 | 按本组约束评估 |
| `mcpServer/tool/call` | 常规导出 | 未接 | 显式工具操作，不能用有副作用调用探测连接 |

### 账户、认证与额度（19）

按当前账户和 Provider 实现专门流程，认证留服务端；切换、退出、消费各自说明影响。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `account/gatewayOAuth/read` | 常规导出 | 未接 | 按本组约束评估 |
| `account/gatewayOAuth/login` | 常规导出 | 未接 | 按本组约束评估 |
| `account/gatewayOAuth/cancel` | 常规导出 | 未接 | 按本组约束评估 |
| `account/login/start` | 常规导出 | 未接 | 按本组约束评估 |
| `account/bedrock/discover` | 实验增量 | 未接 | 按本组约束评估 |
| `account/bedrock/setup` | 实验增量 | 未接 | 按本组约束评估 |
| `account/gcp/setup` | 实验增量 | 未接 | 按本组约束评估 |
| `account/bedrock/checkGovCloudRequirements` | 实验增量 | 未接 | 按本组约束评估 |
| `account/login/cancel` | 常规导出 | 未接 | 按本组约束评估 |
| `accountSession/list` | 实验增量 | 未接 | 按本组约束评估 |
| `accountSession/switch` | 实验增量 | 未接 | 按本组约束评估 |
| `account/logout` | 常规导出 | 未接 | 解释其他客户端与运行任务受影响范围 |
| `account/securitySetup/read` | 常规导出 | 未接 | 按本组约束评估 |
| `account/rateLimits/read` | 常规导出 | 已接 RPC | 已有额度窗口，和上下文占比分开 |
| `account/rateLimitResetCredit/consume` | 常规导出 | 未接 | 涉及额度消费；不自动调用或放普通快捷按钮 |
| `account/usage/read` | 常规导出 | 未接 | 按原生返回口径显示用量 |
| `account/workspaceMessages/read` | 常规导出 | 未接 | 账户工作区消息，与项目聊天分开 |
| `account/sendAddCreditsNudgeEmail` | 常规导出 | 未接 | 会发送提醒；不自动触发 |
| `account/read` | 常规导出 | 已接 RPC | 已有账户状态；认证材料不送前端 |

### 配置、迁移与反馈（10）

读取来源，写前预览与备份；反馈上传须由用户明确触发。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `feedback/upload` | 常规导出 | 未接 | 上传前预览范围，由用户明确提交 |
| `feedback/save` | 常规导出 | 未接 | 本地反馈保存；检查内容和路径 |
| `config/read` | 常规导出 | 未接 | 读取有效配置、层级和来源，过滤秘密字段 |
| `externalAgentConfig/detect` | 常规导出 | 未接 | 按本组约束评估 |
| `externalAgentConfig/import` | 常规导出 | 未接 | 导入前预览差异与备份 |
| `externalAgentConfig/import/recordHistory` | 常规导出 | 未接 | 按本组约束评估 |
| `externalAgentConfig/import/readHistories` | 常规导出 | 未接 | 按本组约束评估 |
| `config/value/write` | 常规导出 | 未接 | 校验、备份并说明生效范围 |
| `config/batchWrite` | 常规导出 | 未接 | 按原生写入语义核对部分失败 |
| `configRequirements/read` | 常规导出 | 未接 | 解释管理员/环境限制 |

### 远控、环境与平台（12）

额外宿主/账户/平台要求；schema 存在不等于已具备官方云中继访问能力。

| 原生方法 | 导出类别 | cweb 状态 | 具体备注 |
| --- | --- | --- | --- |
| `remoteControl/enable` | 实验增量 | 未接 | 需实际宿主、账户与服务支持 |
| `remoteControl/disable` | 实验增量 | 未接 | 按本组约束评估 |
| `remoteControl/status/read` | 实验增量 | 未接 | 按本组约束评估 |
| `remoteControl/pairing/start` | 实验增量 | 未接 | 按本组约束评估 |
| `remoteControl/pairing/status` | 实验增量 | 未接 | 按本组约束评估 |
| `remoteControl/client/list` | 实验增量 | 未接 | 按本组约束评估 |
| `remoteControl/client/revoke` | 实验增量 | 未接 | 仅撤销指定设备，解释影响范围 |
| `environment/add` | 实验增量 | 未接 | 按本组约束评估 |
| `environment/info` | 实验增量 | 未接 | 按本组约束评估 |
| `environment/status` | 实验增量 | 未接 | 按本组约束评估 |
| `windowsSandbox/setupStart` | 常规导出 | 未接 | Windows 专属；Ubuntu 不给无效操作入口 |
| `windowsSandbox/readiness` | 常规导出 | 未接 | 按平台显示 |

## 3. 服务端要求客户端处理的 11 类请求

客户端主动请求只是协议的一半。这里处理不全，就会出现“Agent 在等用户，但网页没有可回答的界面”。当前范围以 `CodexBridge.request` 的分发逻辑为准；支持的请求也要求其会话已经由 cweb 管理。

| 原生请求 | 当前行为 | 建议 |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | 已进入审批队列 | 展示命令、目录、理由、可选决定与有效范围 |
| `item/fileChange/requestApproval` | 已进入审批队列 | 关联实际文件差异和目标范围 |
| `item/tool/requestUserInput` | 已进入问答队列 | 保留题目、选项、自由回复、取消和原生支持的秘密输入语义 |
| `mcpServer/elicitation/request` | **直接返回 decline** | 优先实现表单与 URL 交互；遵循 schema、取消及过期语义 |
| `item/permissions/requestApproval` | 已进入审批队列 | 按原生请求呈现权限对象和生效范围 |
| `item/tool/call` | 已处理内置 Todo/GenUI 动态工具 | 受控工具分发，不代表任意动态工具都已实现 |
| `account/chatgptAuthTokens/refresh` | 未接，通用不支持处理 | 仅在外部令牌认证模式需要时做服务端适配 |
| `attestation/generate` | 未接，通用不支持处理 | 先核对宿主证明要求，不伪造响应 |
| `currentTime/read` | 未接，通用不支持处理 | 有实际需求时实现准确的宿主时间响应 |
| `applyPatchApproval` | 未接旧式名称 | 如需兼容旧版，增加专门适配与回归 |
| `execCommandApproval` | 未接旧式名称 | 不能因新版审批已接就声称旧版也支持 |

源码还兼容 `tool/requestUserInput` 别名；它不在本次导出的 11 类列表中。网页异步问答还可能来自已经适配的原生历史事件，不能仅靠以上请求计数判断所有问答行为。

## 4. 通知与恢复必须一起适配

本版实验导出包含 **86 类服务端通知**，并有 `initialized` 客户端通知。本轮没有逐一实测这些事件。以下是后续开发必须关注的事件族，避免只接请求而丢失执行结果：

| 事件族 | 代表性通知 | 必须验证的行为 |
| --- | --- | --- |
| 生命周期 | `thread/started`、`thread/status/changed`、`turn/started`、`turn/completed`、`error` | 接受请求、运行、失败与完成分开；超时不代表未执行 |
| 工具与流式输出 | `item/started`、`item/completed`、`item/agentMessage/delta`、`item/commandExecution/outputDelta` | 重连去重、增量有序、折叠详情按需加载 |
| 上下文与压缩 | `thread/tokenUsage/updated`、`thread/compacted` | 最近报告与实时测量分开；压缩后核对用量 |
| 队列与会话变化 | `thread/queue/changed`、`thread/reverted`、`thread/readState/changed` | 跨客户端同步，不重复提交 |
| 计划与审查 | `turn/plan/updated`、`turn/diff/updated`、`item/autoApprovalReview/completed` | 计划、差异和审批审核分开呈现 |
| 待处理请求 | `serverRequest/resolved` | 其他客户端处理后，本页撤下失效表单 |
| MCP 与扩展 | `mcpServer/startupStatus/updated`、`mcpServer/oauthLogin/completed`、`skills/changed` | 连接失败、授权完成与列表变化可见 |
| 模型与账户 | `model/rerouted`、`modelProvider/authRecoveryStarted`、`modelProvider/authRecoveryCompleted`、`account/rateLimits/updated` | 显示实际发生的恢复与变化，不根据静默猜测 |
| 终端与文件 | `command/exec/outputDelta`、`process/exited`、`fs/changed` | 输出截断、退出码、订阅释放和文件版本准确 |
| 维护警告 | `warning`、`deprecationNotice`、`configWarning` | 中文说明保留原文，可追溯到具体功能 |
| 远控与实时会话 | `remoteControl/status/changed`、`thread/realtime/error`、`thread/realtime/closed` | 各自能力与连接状态独立，资源关闭完整 |

本表只描述需覆盖的通知语义，不声称 cweb 已经实现全部事件。隐藏推理不作为新增展示项；只使用原生明确提供且允许呈现的进度与结果。

## 5. 不能直接从 schema 搬到网页的部分

1. **版本**：本机二进制、正在运行的 daemon 和 cweb 构建版本分别读取。二进制更新不代表旧进程热升级。
2. **网络诊断**：`server/diagnostics` 是进程诊断。Provider HTTP/WebSocket 连通性需要单独检查；`codex doctor --json --network-only` 可作为候选后端命令，必须限制执行、脱敏并标注检查时间。本轮只检查了帮助，没有运行网络诊断。
3. **分支与记忆**：本版 `thread/fork` 含 `beforeTurnId` / `lastTurnId` 等边界参数，实际行为还受历史形态和版本限制。分支仍共享同目录文件；`thread/memory/read` 返回摘要也不等于读取全部旧对话。
4. **模型能力**：本版 `modelProvider/capabilities/read` 只提供图像生成和网页搜索相关字段，不能据此判断审批、分支、MCP、语音或远控是否可用。
5. **网页终端**：`command/exec`、`thread/backgroundTerminals/*`、`process/*` 分别有不同宿主和生命周期，不能合并为没有所有权约束的进程管理器。
6. **配置和插件**：读取、安装、写入、重载和当前轮次生效是不同步骤；原生服务未明确成功前不能显示已启用。
7. **官方云与远控**：存在 `remoteControl/*`、`environment/*` 不代表 cweb 已获得官方云中继访问资格；先核对官方支持的入口。
8. **账户与反馈**：自动消费额度、发送提醒邮件、上传用户日志不属于连接修复，应有独立界面与明确操作对象。
9. **共享引擎**：重连网页连接不应停止 daemon；终止指定命令也不能影响另一话题。
10. **方法探测**：优先只读调用和当前版本 schema；不要以试调用写入接口来证明支持。

建议先完成 [第一批网络与可靠性验收](2026-11-14-agent-ui-survey.md#9-第一批的具体验收清单)，再按此表补齐常用操作入口。不要把 184 个方法逐一做成按钮。
