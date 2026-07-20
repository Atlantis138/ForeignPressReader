# AI Agent 接续规则

1. 开始前阅读 `README.md`、`CHANGELOG.md`、`package.json`，执行 `git status --short --branch`。
2. 正式 Git 根目录为当前仓库根目录（下文记为 `<repo-root>`）；Windows、Android 和远期 iOS 使用同一仓库，平台差异通过外壳和适配器表达，不建立长期平台分支或复制 core。
3. 不覆盖用户已有修改，不提交样本 EPUB、用户数据库、ECDICT、密钥、备份或构建产物。
4. `src/core` 必须保持纯 TypeScript；平台能力通过端口和适配器实现。
5. `formal-v1` 的 migration 1 是不可改写的正式基线；数据库结构变化必须新增顺序迁移、旧版本升级测试和失败回滚测试。
6. 正式便携备份 format v1 是不可改写的基线；新增或改变用户不可再生数据时，必须新增格式版本，并同时更新便携导出、合并导入、数据契约文档和幂等测试。
7. API密钥只允许经主进程密钥存储读取，不得进入错误信息、日志、测试快照或IPC返回值。
8. Sync Model v1 和内容 ID v2 是正式平台无关契约；任何变化必须新增版本、保留旧版恢复或映射能力，并增加跨平台兼容向量。
9. renderer 只使用 `AppClient`，不得直接访问 Node、SQLite、任意文件系统或模型网络。
10. 完成前运行 `pnpm typecheck`、`pnpm test`；涉及打包时运行 `pnpm dist`。
11. 更新 CHANGELOG 和相关架构/验证文档；只有用户可见的定位、功能、安装、隐私或兼容范围变化才更新 README，README 保持简洁。
12. 正式应用不得读取、迁移或删除旧 Demo 数据，也不得导入 Demo format v5-v7 备份；旧数据目录只能由用户显式处理。
13. 详细历史性能数据、Alpha 过程、协议常量和内部数据表不写入 README；分别保存在 CHANGELOG、验证记录和架构文档。
