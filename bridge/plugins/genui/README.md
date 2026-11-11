# cweb GenUI 适配

来源：本机 `@changfenhuang/dsh-genui` 0.15.0，https://github.com/omdsh-dev/dsh-genui 。包声明 MIT；原文件保留在原安装位置，本工作区使用副本。

`client/` 和 `shared/` 复用原渲染器、规格守卫、局部状态与公式解析；`UPSTREAM_SKILL.md` 为原 Skill，`SKILL.md` 加入 cweb 宿主说明。配套文档与第三方声明一并保留。`source.json` 记录原始校验值。

适配修改：代码 / 差异 / JSON 组件使用 cweb 原语，DSH 类型别名改成本地类型；safe-math 的构造参数属性改为 Node 原生 TypeScript 可擦除语法；主题与正文大小接入 cweb；通过 React Markdown 代码块入口按需加载，而不扫描整页 DOM。绘图资源存于 `bridge/public/genui/`，通过本机静态路径按需加载。

模型工具 `render_ui` 和 `validate_dsh_ui`、会话面板持久化、操作回传由 cweb 提供，不加载 Cordis 或 DSH 运行时。面板数据在 `bridge/.data/plugins/genui/`，浏览器表单状态使用原渲染器的会话 / 内容指纹机制。原软件与全局 Codex Skills 配置不受此适配写入。

通用 DSH 插件宿主、dsh-go 投影和 DSH 专有侧边服务不在此适配内；地图或外部媒体需有可访问的对应资源。
