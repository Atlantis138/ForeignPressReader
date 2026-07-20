# 阶段 C Android 本地阅读验证记录

> 状态：实现完成，待合并
> 分支：`feature/android-local-reading`
> 日期：2026-07-12
>
> 历史说明：本文记录阶段 C 当时的实现。当前版本已由 migration 2 改为 parsed-only 刊物存储；导入 staging 在解析后删除，`library/<publicationId>/source.epub` 不再保留。

## 范围与结论

阶段 C 已完成“系统选择 EPUB → 私有复制与校验 → 规范化入库 → 目录 → 正文与图片 → 阅读位置 → 冷启动恢复”的最小闭环。Windows 继续使用 Electron，Android 使用 Tauri 2；本阶段没有修改 `formal-v1` migration 1、便携 format v1、Sync Model v1 或内容 ID v2。

本阶段明确不包含词典、生词、FSRS、翻译、朗读、便携备份、完整移动功能覆盖和局域网同步。

## 实现边界

导入采用混合流式方案：

1. Kotlin 插件调用 Android `ACTION_GET_CONTENT`，把用户选择的无 DRM EPUB 单次复制到应用私有 `.staging/imports/<sessionId>/source.epub`。
2. Rust 对原始文件计算 SHA-256，流式验证 ZIP 路径、重复入口、CRC、条目数量和展开量，并只向 Web Worker 提供经过白名单检查的 XML/OPF/XHTML/HTML/NCX 文本入口。
3. Web Worker 复用 `src/core/epub-importer.ts` 的来源 Profile、HTML 清理、章节顺序和内容 ID v2，返回不含二进制和绝对路径的逻辑计划。
4. Rust 只提取计划实际引用的 JPEG/PNG/GIF/WebP，执行空间预检，再在同一 SQLite 事务内写入现有 `formal-v1` 表；私有目录发布失败会回滚数据库并删除半成品。
5. renderer 通过窄 `MobileReadingClient` 读取逻辑 DTO。图片 URL 由 Rust 根据数据库引用生成，只读 `reader-asset` 协议再次校验刊物、逻辑路径和 MIME。

固定限制：原始 EPUB 500 MiB、最多 4,000 个 ZIP 入口、总展开量 1 GiB、单文本 16 MiB、单图片 64 MiB、提取图片总量 750 MiB，并预留 64 MiB 可用空间。

## 数据与恢复

- 原始 EPUB：`library/<publicationId>/source.epub`，属于用户源文件。
- 解压图片：`library/<publicationId>/assets`，可由 EPUB 重建。
- 规范化刊物、栏目、文章、内容块、阅读位置和外观偏好：现有 `reader.sqlite` / `formal-v1` 表，没有新增 migration。
- 解析失败、选择取消和提交失败会删除会话目录；应用启动会清空旧导入 staging，并只清理名称符合内容 ID v2 且数据库不存在对应记录的受管孤儿刊物目录。
- 原始 SHA-256 用于同设备重复导入；固定 `epub-content-v2` 向量由 TypeScript 和 Rust 共同验证逻辑 ID 不被平台重写。

## 自动验证

| 范围 | 覆盖 |
| --- | --- |
| TypeScript core | JSZip 快速路径与流式 archive reader 等价、来源 Profile、HTML 清理、内容 ID v2 向量、真实样本计数 |
| renderer 边界 | 窄 command 映射、结构化错误、失败清理、取消后 Promise 收敛、无 SQL/FS/dialog/HTTP guest 插件 |
| Rust 导入 | ZIP/CRC、container、路径穿越、入口白名单、camelCase DTO、提交中取消、空间与资源上限 |
| Rust repository | 事务发布失败回滚、书库/目录/正文读取、偏好与阅读位置、受管孤儿清理、共享内容向量 |
| 阅读定位 | block/token/块内比例稳定锚点与像素回退 |
| 既有基线 | Electron 类型检查、全量 Vitest、Rust test/fmt/Clippy、Windows NSIS |

最终门禁：`pnpm typecheck` 通过；22 个 TypeScript 测试文件共 104 项通过、2 项按外部样本条件跳过；2026-07-11 真实 EPUB 接受测试单独通过；24 项 Rust 测试、`cargo fmt`、零警告 Clippy、ARM64/x86_64 Android debug 构建和 `pnpm dist` Windows NSIS 打包均通过。

## 真机与模拟器

外部测试输入为 `TheEconomist.2026.07.11.epub`（7,160,725 字节），只从用户指定位置和设备 Download 目录读取，未复制进仓库、测试向量、日志、快照或安装包。

固定解析结果：

- 原始 SHA-256：`339ad1eccb7a289384138685704dd0fba8bd92b7bc512a4046f6e61035577755`
- 刊物 ID：`pub_d1b620c280b147bcf52c08bd`
- 来源 Profile：`economist`
- 20 个栏目、76 篇文章、1,305 个内容块、0 篇未分栏文章
- 封面逻辑路径：`EPUB/static_images/cover.jpg`

| 场景 | 华为 OCE-AL50 / API 31 / ARM64 | API 35 AVD / x86_64 |
| --- | --- | --- |
| 干净/覆盖安装与静态入口 | 通过 | 通过 |
| 系统选择器与真实 EPUB 导入 | 通过 | 通过 |
| 20 栏目 / 76 文章 | 通过 | 通过 |
| 正文与受控图片（960×631） | 通过 | 通过 |
| 强制结束与冷启动继续阅读 | 通过 | 通过 |
| 稳定锚点恢复 | 420 px 对应锚点恢复约 411 px | 可滚动上限约 372 px 精确恢复 |
| 系统返回：外观 → 正文 → 目录 → 书库 | 通过 | 主路径通过 |
| 重复导入不增加记录且 staging 为空 | 通过 | 由相同原生/数据库路径覆盖 |
| 选择器返回取消且 staging 为空 | 通过 | 由相同原生/数据库路径覆盖 |

## 实施中发现并固化的缺陷

- Android 插件最初缺少显式 Activity Result AndroidX 依赖，表现为 Kotlin 编译失败；已固定依赖并由 ARM64/x86_64 构建覆盖。
- Tauri `app_data_dir` 在 Android 对应应用 data 根目录，而不是 `filesDir`；选择器目的路径校验已改为限定在 `activity.dataDir/.staging`。
- Rust 带标签枚举最初只转换 variant 名，内部字段仍是 snake_case，导致 Web Worker 收到空 `contentHash`；现使用 `rename_all_fields = "camelCase"` 并有序列化回归测试。
- 静态 Tauri 窗口最初默认打开 Electron `index.html`；窗口现明确加载 `tauri.html`，诊断探针只在开发模式显式启用。
- 解析失败和 worker 取消最初可能留下挂起 Promise 或会话；客户端与 Rust 现在均执行幂等取消和失败清理。

## 后续入口

阶段 D 应从词典包与学习数据端口设计开始，不扩写本阶段导入协议。尤其不得把 ECDICT SQLite、任意查询、文件路径或 Android API 暴露给 renderer；应继续复用 `AppClient`、逻辑 DTO、稳定 ID 和固定跨平台向量。
