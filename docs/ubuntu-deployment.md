# Ubuntu 部署与迁移

cweb 是单用户、本机访问的 Codex CLI 网页桥接。项目文件独立于官方 CLI 和 dsh；网页对话由本机 `codex app-server` 执行。以下步骤适用于有桌面浏览器的 Ubuntu；其他 Linux 环境可能可用，但未逐一验证。

## 准备

安装 Git、Node.js **24.9 或更新版本**（包含 npm）和 Codex CLI。先确认在准备启动 cweb 的同一个终端里可以找到它们：

```bash
git --version
node --version
npm --version
codex --version
codex app-server --help
```

Node.js 的安装方式见 [Node.js 下载页面](https://nodejs.org/en/download)；Codex CLI 的安装与登录方式见 [Codex 文档](https://developers.openai.com/codex/)。推荐先确认终端里的 Codex 按你的登录方式或模型提供商配置正常工作；如果使用官方登录，可以运行 `codex login status`，需要登录时运行 `codex login`。cweb 继承启动终端的环境变量，不在网页中配置登录凭据。

下面的示例使用你自己的仓库地址；替换引号内地址后运行：

```bash
git clone 'https://github.com/用户名/仓库名.git' cweb
cd cweb
npm run setup
./cweb
```

`npm run setup` 会按 `bridge/package-lock.json` 执行 `npm ci` 并构建前端；需要联网下载依赖。依赖、构建结果和 npm 缓存留在项目目录中。`./cweb` 在后台启动，优先尝试 Edge，再尝试 `xdg-open`，并立即释放终端。如果没有自动打开，在本机浏览器访问 **http://127.0.0.1:4780**。在网页里添加需要使用的工作区即可，启动时不必预先指定项目。

仓库中的 `cweb` 是可执行脚本。如果复制文件时丢失可执行权限，可先执行 `chmod +x cweb`，或直接用 `node scripts/cweb.mjs` 启动。

## 常用命令

在仓库根目录执行：

```bash
./cweb status                  # 查看地址和任务状态
./cweb start --no-browser      # 后台启动，手动打开网页
./cweb start --port 4781       # 选择其他端口
./cweb logs                    # 查看日志
./cweb stop                    # 正常停止，运行中的任务会阻止停止
./cweb restart                 # 正常重启并打开网页
```

如要在任意终端直接输入 `cweb`，可选地先预览，再安装用户级启动入口：

```bash
node scripts/install-launcher.mjs
node scripts/install-launcher.mjs --install
```

第二条命令会在项目外创建 `~/.local/bin/cweb`，已有同名文件时拒绝覆盖；该目录须在 `PATH` 中。入口记录当前 Node 和仓库的绝对路径，移动仓库或删除该 Node 版本后需要重新安装：先正常停止服务，确认并移除旧的 cweb 入口，再运行安装命令。

有多个 CLI 或浏览器版本时，可在**启动服务的终端**指定实际可执行文件：

```bash
CWEB_CODEX=/绝对路径/codex ./cweb start
CWEB_BROWSER=/绝对路径/浏览器 ./cweb start
```

已有服务会被复用，修改环境变量后需在任务结束时使用相同环境正常重启。需要显式中断正在执行的任务时，才使用 `./cweb stop --force`。

## 会话、凭据与备份

默认使用启动环境的 `CODEX_HOME`；未设置时使用当前用户的 `~/.codex`，因此网页和该用户的终端 CLI 共享原生会话。优先连接检测到的本机原生常驻 app-server，否则由 cweb 启动自己的 stdio app-server。版本、登录和模型服务配置由所使用的 CLI 决定；在网页新建会话或添加工作区后即可验证。

**Git 备份的是应用源码，不是用户数据或登录状态。** `bridge/.data/` 包含工作区路径、附件、便签、日志、控制令牌等本机数据；`~/.codex/` 可能包含认证信息和会话。请勿将这些目录、`.env` 或凭据上传到仓库。如需迁移个人会话和便签，应另行选择安全渠道，并核对新电脑路径与权限；仅克隆仓库不会自动带来旧会话和便签。Git 忽略规则也不会自动移除已经被 Git 跟踪的文件，首次推送前请检查暂存清单。

网页默认只监听 `127.0.0.1`，用于本机浏览器；不要直接将其暴露到公网。完全权限模式会允许 CLI 访问本机文件和网络并关闭逐次审批，请按实际需要选择权限。

## 让 Codex CLI 协助部署

先在新电脑克隆仓库，进入仓库根目录并启动 Codex CLI，然后可发送：

```text
请在当前 cweb 仓库帮助我部署到这台 Ubuntu 电脑：
1. 检查 README 和 docs/ubuntu-deployment.md，确认 Node.js、npm、Git 和 codex 版本，以及 codex app-server 可用性。
2. 在当前仓库内执行 npm run setup，检查构建结果；保留已有数据和配置。
3. 使用 ./cweb start --no-browser 启动，检查 ./cweb status，告诉我本机访问地址。
4. 检查 CLI 当前是否可用，说明网页如何与现有终端会话共享；不要输出或复制任何凭据。
5. 如需安装系统软件、修改仓库外配置或创建 ~/.local/bin/cweb，请先说明具体操作并请求我的许可。不要强制停止其他任务或进程。
```

若软件缺失或需要登录，助手应报告缺项，由你决定如何安装、登录或授权。命令会启动后台本地服务；不要在不信任的机器上提供凭据或开启完全权限。

## 常见问题

- **`node` 版本过低或 `npm ci` 失败**：先切换到 Node.js 24.9+，确认 npm、网络和 `bridge/package-lock.json` 完整，再在仓库根目录运行 `npm run setup`。
- **找不到 `codex` / 无法连接模型**：在启动 cweb 的同一终端检查 `command -v codex`、`codex --version`、登录状态和所需环境变量；也可用 `CWEB_CODEX` 指定 CLI 路径。修改环境后正常重启 cweb。
- **浏览器没有打开**：使用 `./cweb status` 查看地址，手动访问；也可通过 `CWEB_BROWSER` 指定浏览器。无图形桌面的机器不会自动出现本地浏览器。
- **端口已被占用**：使用 `./cweb start --port 4781`，或在服务已运行时先正常停止，再用新端口启动；不要结束未知进程。
- **正常停止被拒绝**：先等待或在网页停止正在执行的任务，再运行 `./cweb stop`。`--force` 会中断任务，应由用户主动决定。
- **会话列表与终端不一致**：确认网页服务和终端使用同一个系统用户、`CODEX_HOME` 与 CLI；检查工作区路径。网页重获焦点及定期刷新会重新读取列表。另请注意，复制 Git 仓库不会迁移旧机器的会话数据。
- **查看诊断信息**：先运行 `./cweb status`、`./cweb logs`；分享日志前自行检查并清理可能包含的路径或敏感信息。
