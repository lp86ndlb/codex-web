# dsh-todo-note · cweb 适配

来源：本地 dsh-todo-note 项目，版本 0.1.8，提交 `4d9db4132f1b03ad0f40e7e41170be0223b5f724`。原目录和原 dsh 数据未修改。

- `upstream/client.js`：原界面副本；`upstream/model.js` 在原模型上增加 `paused` 阶段状态，其他数据格式兼容原版。
- `upstream/LICENSE`：原 MIT 许可证及版权声明。
- `SOURCE.json`：来源、版本、提交、原文件 SHA-256。
- `client.js`：适配加载、请求与偏好，并显示 agent 明确标记的当前任务及搁置阶段。
- `guide.js`：扩展后的模型使用说明，要求每轮核对任务、保留用户确认和阶段切换。
- `../../client/TodoNote.tsx`：React、会话选择、会话发送、样式生命周期和插槽的最小宿主适配。
- `../../server/todo-note.ts`：官方 Codex 动态工具映射，严格输入校验，每会话独立 JSON 与事务保存。

界面通过 cweb 已有的同源鉴权接口通信。样式令牌由 cweb 提供，字号覆盖在 cweb 样式中，不修改原副本。偏好键为 `cweb:todo-note:prefs:v1`；数据仅写入 `bridge/.data/plugins/todo-note/`。

这不是通用 dsh 插件加载器。没有执行原 host.js，也没有模拟完整的 DSH API。旧原生会话通过 `mcp.mjs` 在重新载入时连接相同的会话便签；新会话继续使用原生动态工具。若旧会话正被另一端保持加载，网页会等待它释放后再接入。

宿主将一次工具的多项操作放在同一持久化事务中，不吞掉保存错误，也不自动清理旧会话便签。AI 的完成工具只进入 awaiting，用户确认后才进入最近完成。实时高亮依赖 agent 把当前焦点设置为任务的确切标题，不会猜测执行进度。较旧会话的固定工具定义若不支持 paused，可使用 todo 状态并在焦点中说明搁置。
