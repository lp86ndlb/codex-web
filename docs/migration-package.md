# 私人迁移包：Ubuntu 24.04 x86_64

此包用于把自己的 cweb 搬到另一台电脑。它包含私人会话、上传附件、待办和仓库历史，**不要上传 GitHub 或公开网盘**。

## 新电脑只需这几步

1. 将 ZIP 解压到你准备长期使用的空目录，里面有一个 `cweb` 文件夹。用户名、父目录可以不同，路径可以包含空格和中文。不要覆盖已有 cweb 目录。
2. 在解压后的 `cweb` 文件夹打开终端，运行：

   ```bash
   bash cweb
   ```

   首次会校验文件并重定位会话，随后启动网页。无需 `npm install`、重建前端或安装 Node；包内已包含运行环境。需有 Python 3（Ubuntu 24.04 自带）和可在终端运行的 Codex CLI 0.169。默认网址是 `http://127.0.0.1:4780`。
3. 新电脑已有 `~/.codex/auth.json` 时，首次恢复会复制这台电脑的登录状态。未登录或登录失效时运行 `bash codex-portable login`，然后重新运行 `bash cweb`。使用自定义供应商的用户仍需在启动终端提供自己的环境变量或连接配置。
4. 在左侧 `codex-web` 工作区打开原来的开发话题继续。也可运行 `bash 继续开发会话.sh` 在 CLI 中恢复同一个会话；发送“请阅读 MIGRATION_HANDOFF.md，核对迁移结果后继续维护 cweb”。

解压工具没有保留可执行权限也没关系：`bash cweb` 会修复包内所需权限与 npm 的符号链接。没有图形解压工具时可用 `python3 -m zipfile -e /路径/迁移包.zip /目标父目录`。

## 包里有哪些数据

- cweb 源码、Git 历史、已构建网页、全部 npm 依赖、Node 与 npm。
- cweb 工作区列表、网页设置、全部上传附件、待办、GenUI 面板、编辑前备份及运行统计。
- 原生 Codex 活跃与归档会话、会话索引及分页历史数据库、目标记录、持久记忆数据库、技能与插件缓存。开发者会话 ID 保持不变。
- 常用的历史回复截图和评审文档，以及 `MIGRATION_HANDOFF.md` 开发交接说明。

会话保留原生的历史和已有压缩摘要；模型不会把全部旧对话同时放进上下文。运行中的进程、工具、未提交审批、队列任务和网络连接不会搬到新机，也不会自动重放。迁移中的未结束轮次在副本中标为已中断；在新电脑主动发消息接续即可。

未包含：原机账号凭据、SSH 私钥、其他工作区的项目文件、浏览器配置与 localStorage（手动排序、宽度、草稿、已读标记等浏览器本地状态）、系统 `/tmp` 临时文件和多数测试缓存。因此旧回复引用的已清理临时图片可能仍不可用。其他工作区的会话保留，但其项目文件需另行复制；原用户名目录会替换为新电脑用户目录，具体缺失路径见 `.migration/ready.json`。

## 会话如何接续

本包使用独立的 `CODEX_HOME=<解压目录>/.migration/codex`，网页和 `codex-portable` 共享它，**不会覆盖新电脑已有的 `~/.codex`**。直接运行系统 `codex` 使用的是新机原有的会话库；找不到迁移会话时请用 `bash codex-portable resume --all`。不要同时在网页和 CLI 向同一个话题发送任务。

这是一份制作时刻的快照。打包完成后在原机新增的消息与文件不会自动同步。新旧电脑的原话题都可以继续使用，但两边后续内容会各自发展。源机不会被停止或修改。

需要继续 Git 推送时，在新机自行配置 GitHub 登录或 SSH 密钥。包内移除了旧电脑专用 SSH 路径，保留 HTTPS 仓库地址及提交历史。

## 日常命令

```bash
bash cweb doctor
bash cweb status
bash cweb start --no-browser
bash cweb start --port 4781
bash cweb stop
bash cweb restart
bash codex-portable login status
bash 继续开发会话.sh
```

如需在任意终端输入 `cweb` 并使用 Tab 补全，可选地运行：

```bash
bash scripts/migration/run.sh --install-launcher
```

这一步会新建 `~/.local/bin/cweb` 与用户级 Bash 补全；已有同名入口时拒绝覆盖。确保 `~/.local/bin` 在 PATH 中，新开终端后使用。

## 校验和恢复保障

迁移包旁有 `.zip.sha256` 文件，可在该目录运行 `sha256sum -c 文件名.zip.sha256`。首次启动还会验证包内文件清单。原始数据快照保留于 `.migration/snapshot.tar.gz`；数据库通过 SQLite 备份接口获取，包含已提交的 WAL 数据，路径变化时同步重算原生分页的字节偏移。

恢复只写解压目录，拒绝覆盖已有运行数据。若恢复中断，使用相同目录再次运行 `bash cweb`；完成后可重复启动，不会再次导入。**已经开始使用的目录不要再移动**：需要换位置时重新打包当前数据，或在尚未开始使用时重新解压原 ZIP；旧 ZIP 不含之后的新内容。

Ubuntu 24.04 x86_64 需要常规运行库（glibc、libstdc++、libatomic）、Git 和桌面浏览器。桌面版通常已具备；极简系统可安装 `git libatomic1 xdg-utils`。恢复和查看本地历史不需要连接模型，向模型发送消息仍需要正常的账号与网络。首次恢复可能需数十秒至几分钟，取决于磁盘与历史大小。

## 为下一次迁移制作新包

先 Git 备份，再构建当前前端，然后运行（会话 ID 可在网页顶部复制 CLI 命令处找到）：

```bash
PATH="$PWD/.runtime/bin:$PATH" npm --prefix bridge run build
python3 scripts/migration/pack.py \
  --codex-home "$PWD/.migration/codex" \
  --node "$PWD/.runtime/bin/node" \
  --developer-thread 你的会话ID \
  --output "$PWD/backups/cweb-next-migration.zip"
```

首次在普通安装中制作包时不传 `--codex-home` 和 `--node`，默认使用启动环境的 Codex 数据和 Node。备份生成后，请在新的空目录先验证恢复。
