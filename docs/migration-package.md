# 私人迁移包：Ubuntu 24.04 x86_64

此包用于把自己的 cweb 搬到另一台电脑。它包含私人会话、上传附件、待办和仓库历史，**不要上传 GitHub 或公开网盘**。

## 新电脑只需这几步

1. 将 ZIP 解压到你准备长期使用的空目录，里面有一个 `cweb` 文件夹。用户名、父目录可以不同，路径可以包含空格和中文。不要覆盖已有 cweb 目录。
2. 在解压后的 `cweb` 文件夹打开终端，运行：

   ```bash
   bash cweb
   ```

   首次会校验文件、重定位会话、安装用户级 `cweb` 入口与 Bash 工作区绑定，随后启动网页。无需 `npm install`、重建前端或安装 Node；包内已包含运行环境。需有 Python 3（Ubuntu 24.04 自带）和可在终端运行的 Codex CLI 0.169。默认网址是 `http://127.0.0.1:4780`。如果已有同名自定义入口会保留并提示；此时 `bash cweb` 仍可启动，运行 `bash cweb doctor` 查看未完成项。
3. 新电脑已有 `~/.codex/auth.json` 时，首次恢复会复制这台电脑的登录状态。未登录或登录失效时运行 `bash codex-portable login`，然后重新运行 `bash cweb`。使用自定义供应商的用户仍需在启动终端提供自己的环境变量或连接配置。
4. 新开 Bash 终端，在此工作区输入 `cweb` 和 `codex resume`，确认能打开网页并找到开发会话。旧终端先执行 `source ~/.bashrc`，已经启动的 Codex 需退出后重开。也可运行 `bash 继续开发会话.sh` 恢复指定开发会话；发送“请阅读 MIGRATION_HANDOFF.md，核对迁移结果后继续维护 cweb”。

解压工具没有保留可执行权限也没关系：`bash cweb` 会修复包内所需权限与 npm 的符号链接。没有图形解压工具时可用 `python3 -m zipfile -e /路径/迁移包.zip /目标父目录`。

## 包里有哪些数据

- cweb 源码、Git 历史、已构建网页、全部 npm 依赖、Node 与 npm。
- cweb 工作区列表、网页设置、全部上传附件、待办、GenUI 面板、编辑前备份及运行统计。
- 所选 `CODEX_HOME` 中的原生 Codex 活跃与归档会话、会话索引及分页历史数据库、目标记录、持久记忆数据库、技能与插件缓存。开发者会话 ID 保持不变。
- 常用的历史回复截图和评审文档，以及 `MIGRATION_HANDOFF.md` 开发交接说明。

会话保留原生的历史和已有压缩摘要；模型不会把全部旧对话同时放进上下文。运行中的进程、工具、未提交审批、队列任务和网络连接不会搬到新机，也不会自动重放。迁移中的未结束轮次在副本中标为已中断；在新电脑主动发消息接续即可。

未包含：原机账号凭据、SSH 私钥、其他工作区的项目文件、浏览器配置与 localStorage（手动排序、宽度、草稿、已读标记等浏览器本地状态）、系统 `/tmp` 临时文件和多数测试缓存。因此旧回复引用的已清理临时图片可能仍不可用。其他工作区的会话保留，但其项目文件需另行复制；原用户名目录会替换为新电脑用户目录，具体缺失路径见 `.migration/ready.json`。

网页聚合显示的外部会话库不自动并入迁移包。例如，包内使用 `.migration/codex` 时，本机另有的 `~/.codex` 需要单独备份；打包前应核对需要迁移的会话来源。

## 会话如何接续

本包使用独立的 `CODEX_HOME=<解压目录>/.migration/codex`，网页和 `codex-portable` 共享它，**不会覆盖新电脑已有的 `~/.codex`**。网页同时在后台发现当前用户 `~/.codex` 及运行中 Codex 进程的其他会话库，按工作区统一列出并连接原服务；不复制运行中的会话。某个外部服务暂时不可用时，不影响迁移会话的载入。终端正在执行的任务可在网页查看，结束后可检查并接续。

安装后的 Bash 会在 cweb 工作区及其子目录把 `codex` 路由到同一个会话库，因此 `codex resume` 能找到网页正在使用的开发会话。它共享原生文件，不复制或同步两份历史。其他目录、显式设置的 `CODEX_HOME`、已有自定义 `codex` 函数或别名保留原行为；`command codex` 可绕过工作区绑定。此绑定不会把其他库中的会话导入 CLI 的选择器，网页仍汇总其他来源。Zsh/Fish 或未加载 Bash 配置时使用 `bash codex-portable resume --all`，或网页“复制终端继续命令”。不要同时在网页和 CLI 向同一个话题发送任务。

若 `/resume` 仍看不到迁移会话，先退出当前 Codex、回到 shell，在 cweb 根目录执行 `bash codex-portable resume`。这条入口不依赖旧终端是否加载新配置。`bash cweb doctor` 会提示同工作区仍使用其他库的终端进程；配置安装成功不能改变已经启动的 CLI。

如果要让新电脑已有话题和迁移话题同时出现在普通 `/resume`，须按[原生历史统一流程](native-history.md)合入空闲来源库并绑定默认目录。首次解压不会擅自覆盖新电脑的库；`doctor` 会明确区分“入口已配置”和“原生会话库已统一”。已统一的安装可直接运行普通 `codex`。

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

旧迁移包漏装命令、升级绑定规则或修复入口时，可重复运行：

```bash
bash scripts/migration/run.sh --install-launcher
```

这一步会安装 `~/.local/bin/cweb`、用户级 Bash 补全，以及 `~/.config/cweb/shell.bash` 工作区绑定；为 `.bashrc` 和 `.profile` 添加带标记的配置，并在修改前备份。相同安装可重复执行，其他安装或自定义入口不会被覆盖。详情见[迁移复盘与日常维护](migration-lessons.md)。

## 校验和恢复保障

迁移包旁有 `.zip.sha256` 文件，可在该目录运行 `sha256sum -c 文件名.zip.sha256`。首次启动还会验证包内文件清单。原始数据快照保留于 `.migration/snapshot.tar.gz`；数据库通过 SQLite 备份接口获取，包含已提交的 WAL 数据，路径变化时同步重算原生分页的字节偏移。

会话恢复只写解压目录，拒绝覆盖已有运行数据；命令安装另写入上述用户级入口与带备份的 shell 配置。若恢复中断，使用相同目录再次运行 `bash cweb`；完成后可重复启动，不会再次导入。**已经开始使用的目录不要再移动**：需要换位置时重新打包当前数据，或在尚未开始使用时重新解压原 ZIP；旧 ZIP 不含之后的新内容。

Ubuntu 24.04 x86_64 需要常规运行库（glibc、libstdc++、libatomic）、Git 和桌面浏览器。桌面版通常已具备；极简系统可安装 `git libatomic1 xdg-utils`。恢复和查看本地历史不需要连接模型，向模型发送消息仍需要正常的账号与网络。首次恢复可能需数十秒至几分钟，取决于磁盘与历史大小。

## 为下一次迁移制作新包

先 Git 备份，再构建当前前端，然后运行（会话 ID 可在网页顶部复制 CLI 命令处找到）：

```bash
PATH="$PWD/.runtime/bin:$PATH" npm --prefix bridge run build -- --outDir ../.cache/migration-release
python3 scripts/migration/pack.py \
  --codex-home "$PWD/.migration/codex" \
  --node "$PWD/.runtime/bin/node" \
  --dist "$PWD/.cache/migration-release" \
  --developer-thread 你的会话ID \
  --output "$PWD/backups/cweb-next-migration.zip"
```

首次在普通安装中制作包时不传 `--codex-home` 和 `--node`，默认使用启动环境的 Codex 数据和 Node。备份生成后，请在新的空目录先验证恢复。
