# 贡献指南

欢迎围绕真实问题提交修复、改进文档或提出功能建议。开始前可先阅读 [使用指南](docs/usage.md)、[架构与目录](docs/architecture.md) 和 [Ubuntu 部署](docs/ubuntu-deployment.md)。

## 本地开发

需要 Node.js 24.9+、npm 和 Git。运行真实会话还需要配置可用的 Codex CLI。

```bash
npm run setup
CWEB_DATA_DIR="$PWD/.cache/dev-data" npm run dev -- --port 4781
```

上面的命令使用独立的网页数据目录和端口，避免占用默认运行实例。服务默认仍使用本机 CLI 的会话和配置。开发验证优先使用测试提供的隔离环境；需要自己的 CLI 数据目录时，先阅读 [数据边界](docs/architecture.md#数据归属)。不要在测试中使用他人的工作区、认证信息或正在执行的会话。

## 提交改动

1. 在 Issue 或 PR 中描述可复现的问题、预期行为和实际行为，附相关版本与最小复现步骤。
2. 保持改动聚焦，优先复用已有组件、主题令牌、协议类型和交互逻辑。依赖变化同时更新 `bridge/package-lock.json`。
3. 根据改动运行对应检查。文档修改可检查命令与链接；交互修改应验证相关浏览器行为；协议、权限或持久化修改需要对应的实际状态验证。
4. PR 说明结果、验证方式及已知限制。行为、参数或部署流程改变时更新相应文档。

常用检查：

```bash
npm run check
npm test
npm run build
npm run test:browser
```

现有浏览器脚本使用 Microsoft Edge，默认路径为 `/usr/bin/microsoft-edge`；部分脚本接受 `BROWSER_EXECUTABLE`，请检查对应脚本后选择环境。浏览器验证需要先构建前端，截图与临时文件保存在已忽略的 `bridge/test-results/`。协议自动测试使用确定性的 CLI 替身，不调用付费模型；真实模型验证需自行确认账户与调用成本。

## 提交前检查

检查 `git diff --cached` 和暂存文件列表。不要提交会话、附件、便签内容、账户配置、API key、OAuth token、环境文件或调试日志；忽略规则不会自动移除已经被 Git 跟踪的数据。分享截图和错误日志前检查其中的用户内容与本机路径。

保留内置第三方组件与插件的来源、版权和许可证。修改 `bridge/plugins/` 或 `bridge/client/dsh/` 中的适配代码时，在相应说明中记录宿主差异，不暗示项目获得官方背书。

涉及认证信息或可利用漏洞的问题，不要在公开 Issue 中粘贴秘密或利用细节。可先通过 GitHub 提供的私密漏洞报告功能联系维护者（如果仓库已启用）；没有可用私密渠道时，先提交不含敏感内容的联系请求。
