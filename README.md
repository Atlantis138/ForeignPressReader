# 外刊阅读器

![外刊阅读器 Logo](src-tauri/icons/128x128.png)

> 本项目是作者为个人使用开发和维护的本地优先外刊阅读与英语学习软件。v1.0.0 的 EPUB 导入仅保证兼容并完成验收 [hehonghui/awesome-english-ebooks](https://github.com/hehonghui/awesome-english-ebooks) 中提供的《The Economist》EPUB；其他来源或版式暂不保证可用。本项目与该仓库及《The Economist》不存在隶属关系，不捆绑、镜像或再分发任何刊物内容；MIT 许可仅覆盖本项目自身代码和图形资产。

外刊阅读器是一款面向 Windows 和 Android 的 EPUB 阅读与英语学习应用。两端共用纯 TypeScript 核心，数据默认只保存在本机，也可以在同一局域网内手动同步。

已发布版本：`1.0.0`。当前源码另含尚未发布的阅读记录、译文版本、恢复和后台朗读改进，详见 [CHANGELOG](CHANGELOG.md)。

## 主要功能

- 导入、整理和阅读外刊 EPUB，支持栏目、文章、图片、阅读位置、全文搜索与浅色/深色主题。
- 支持 DeepSeek、OpenAI、Kimi 翻译，以及系统、Google、MiniMax 语音服务。
- 提供 ECDICT 本地词典、在线补充释义、查词、生词、语境收藏和词集筛选。
- 使用 FSRS-6 进行每日复习、长期计划、学习记录和进度管理。
- Windows 与 Android 可在局域网内配对，预览差异并手动同步书库与学习数据。
- 支持 `.fprbackup` 便携备份；原始 EPUB、词典、缓存、密钥和设备身份不会进入备份或同步载荷。未发布源码支持保留译文版本，这些版本作为用户数据进入备份和同步。

源码中的新增功能：按文章恢复进度、书签/已读筛选与全库正文搜索；同一原始 EPUB 再次导入可补回旧解析遗漏；Android 文章朗读支持切后台、锁屏和通知控制。两端升级后才能使用新版局域网同步。

Windows 与 Android 源码均支持翻译刊物目录并在重启后复用本机缓存、返回目录时恢复位置、译文跟随正文字号，以及保存和删除本机自定义翻译模型。

## 下载与安装

请从 [GitHub Releases](https://github.com/Atlantis138/ForeignPressReader/releases/latest) 下载：

- Windows 10/11 x64：`ForeignPressReader-1.0.0-Setup.exe`
- Android ARM64：`ForeignPressReader-1.0.0-android-arm64.apk`
- 文件校验：`SHA256SUMS.txt`

Windows 安装包暂未使用 Authenticode，首次运行可能出现 Microsoft Defender SmartScreen 提示。请只从本仓库 Release 下载并核对 SHA-256。覆盖安装 v1.0 Alpha 前，建议先在应用设置中创建便携备份；卸载程序默认保留用户数据。

Android 正式包的 application ID 为 `com.local.foreignpressreader`。正式包不会读取、迁移或删除旧 Demo 或 `.dev` 调试应用的数据。

## 数据与隐私

- 没有账号、遥测、云端同步或后台自动上传。
- 原始 EPUB 仅作为一次性导入输入；应用不会复制、修改或删除外部原文件。
- API 密钥由 Windows DPAPI 或 Android Keystore 保存，不进入数据库、日志、备份或同步载荷。
- 翻译、在线词典和远程语音只在用户主动触发时访问所选服务；本地阅读和 ECDICT 查词可离线使用。
- EPUB 被视为不可信输入，会经过路径、大小、压缩比、完整性和内容消毒检查。

正式应用不读取、迁移或删除旧 Demo 数据，也不接受 Demo format v5–v7 备份。

## EPUB 与第三方内容

v1.0.0 目前只对上述《The Economist》来源完成兼容验收，不支持 PDF、DRM/LCP 或固定版式电子书。项目和 Release 不包含任何刊物内容。

本项目也不捆绑 ECDICT 数据。用户主动安装本地词典时，应用会从 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT) 的固定 revision 下载所需文件，并在设备本地生成索引。ECDICT 使用 MIT 许可，完整声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 本地开发

环境：Windows 11 x64、Node.js 24、pnpm 11；Android 构建还需要 Rust、JDK 17、Android SDK/NDK 和 Tauri 2 工具链。

```powershell
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm dist
pnpm tauri:android:build
```

Windows 使用 Electron，Android 使用 Tauri 2；`src/core` 保持纯 TypeScript，renderer 只通过统一 `AppClient` 访问平台能力。仓库结构与维护边界见 [AGENTS.md](AGENTS.md) 和 [多平台仓库规划](docs/repository-architecture.md)。

`pnpm dev` 会自动构建并监听主进程；日常逻辑验证可用 `pnpm test:unit`，发布前运行完整 `pnpm test`。未发布的修复及范围见 [项目修复记录](docs/project-repair-2026-09.md)。

## 文档

- [更新记录](CHANGELOG.md)
- [人工发布验证清单](docs/release-validation-checklist.md)
- [Android 移植路线与验证记录](docs/tauri-android-port-roadmap.md)
- [局域网同步设计](docs/future-sync-roadmap.md)
- [局域网同步审计与人工验证清单](docs/sync-validation.md)

## 许可

本项目自身代码和图形资产采用 [MIT License](LICENSE)。第三方项目保留各自版权和许可。
