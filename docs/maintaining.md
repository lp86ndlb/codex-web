# 仓库展示与维护

## README 的组织

首页使用一句定位、少量徽章、演示图、适用场景、快速启动和分层文档导航。组织方式参考以下项目公开 README，不复制其品牌、截图、宣传文案或功能承诺：

- [Open WebUI](https://github.com/open-webui/open-webui)：突出自部署定位、界面演示与启动入口。
- [LobeHub](https://github.com/lobehub/lobehub)：集中展示项目标识、导航与能力层次。
- [Cline](https://github.com/cline/cline)：将不同使用入口与进一步文档明确区分。

徽章仅说明项目当前的技术、部署定位与 [MIT 许可证](../LICENSE)。没有发布或持续集成配置时，不展示虚构的发布、覆盖率或构建通过状态。

`assets/cweb-demo.png` 使用隔离模拟 CLI 和演示会话生成。更新截图时不要截取真实项目、个人工作区或账户；图注须说明演示数据。

## GitHub Topics

[`.github/topics.json`](../.github/topics.json) 保存可复制的建议主题。此文件不会自动修改 GitHub 仓库设置；有维护权限时，在仓库首页 **About → 齿轮 → Topics** 填入：

```text
codex codex-cli coding-agent web-ui local-first self-hosted ubuntu typescript react developer-tools
```

建议 About 描述：

```text
A local browser workspace for Codex CLI — shared sessions, project organization, approvals, and interactive task notes.
```

README 中的 GitHub 地址以 `lp86ndlb/codex-web` 为准。Fork 后如需独立维护，请同步修改克隆命令、问题入口与仓库链接。

Topics 属于 GitHub 仓库元数据，不能通过 `git push` 或 SSH 设置。上面的网页入口不需要安装额外工具；已安装并登录 GitHub CLI、且具有该仓库维护权限时，也可在仓库根目录执行：

```bash
node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.stringify({names: JSON.parse(readFileSync(".github/topics.json", "utf8"))}));' \
  | gh api --method PUT repos/lp86ndlb/codex-web/topics --input -
```

## 通过 SSH 维护代码

本机已配置 GitHub SSH 公钥时，可先验证身份，再将当前仓库的 `origin` 改为 SSH。首次连接须核对 GitHub 主机指纹；不要为了通过检查而关闭主机密钥校验。

```bash
ssh -T git@github.com
git remote set-url origin git@github.com:lp86ndlb/codex-web.git
git ls-remote origin HEAD refs/heads/master
```

GitHub 返回 `successfully authenticated` 并提示不提供 shell 访问，表示 SSH 身份验证成功；`ssh -T` 此时仍可能返回退出码 1。`git ls-remote` 只读取远端引用，不会推送文件。首次部署也可以直接使用：

```bash
git clone git@github.com:lp86ndlb/codex-web.git
```

提交前检查本仓库身份；如需更改，只修改此仓库的配置：

```bash
git config --local user.name
git config --local user.email
git config --local user.email "YOUR_ID+YOUR_LOGIN@users.noreply.github.com"
```

如希望隐藏邮箱，可改用 GitHub 邮箱设置中提供的 `noreply` 地址。更新配置只影响后续提交，不能清除已公开提交中的作者或提交者信息。重写公共历史需要单独评估，不属于正常同步步骤。

## 发布前

1. 检查暂存清单、提交邮箱、截图及构建产物，避免将本机数据带入 Git。
2. 更新部署要求和已验证版本；协议升级时按 [贡献指南](../CONTRIBUTING.md) 验证。
3. 保留根目录 [MIT 许可证](../LICENSE) 与各第三方组件原有的版权、来源和许可证；新增或替换组件时同步更新其声明。
4. 按实际变更记录兼容边界；不要把本地测试结果写成所有电脑都已验证。
