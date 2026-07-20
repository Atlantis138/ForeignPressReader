# 阶段 E0 Android 验证记录

日期：2026-07-13
分支：`codex/android-offline-dictionary`
状态：通过；下一阶段为 E1“书库与本地阅读”完整对齐。

## 1. 验证范围

- Android 正式四模块产品壳：“书库、词典、背单词、设置”。
- 手机底部导航、窄横屏底部导航，以及宽高均满足条件时的 80 dp navigation rail。
- 四个模块各自的类型安全路由栈、查询/筛选/滚动/安全草稿快照、tab 重选和跨模块深链。
- 阅读器与全屏答题沉浸布局、统一 Back 优先级、答题退出确认与进度保留。
- `fpr.android.shell.v1` WebView 快照的版本校验、损坏降级、失效资源降级和敏感/临时状态排除。
- Windows 暖纸、墨色、编辑红语义令牌在浅色/深色、不同字号与设备尺寸下的移动表达。
- D1-D3 离线词典、生词、语境、学习计划与 FSRS 单卡能力在正式模块中的重新挂载。

## 2. 自动化结果

| 门禁 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 27 个测试文件；125 项通过，2 项按设计跳过 |
| `cargo fmt --check` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 41 项通过，1 项完整外部 ECDICT 源测试按设计忽略 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过，零警告 |
| Android ARM64 debug APK | 通过 |
| Android x86_64 debug APK | 通过 |
| `git diff --check` | 通过 |

新增的 renderer 测试覆盖四 tab 独立栈、tab 重选、跨模块深链、沉浸页面、Back 顺序、根页系统退出、快照序列化、损坏/未知版本、非法数值、失效资源和安全字段排除。语义/布局断言覆盖 SVG 图标、48 dp 触摸目标、安全区、840 dp rail 条件、窄横屏底栏、ARIA 与 reduced-motion。

## 3. 确定性视觉矩阵

运行 `pnpm ui:mobile:capture` 共生成 28 张忽略 Git 的截图到 `test-artifacts/mobile-e0`：

- 360 × 800，浅色，书库/词典/背单词/设置/阅读器/全屏答题；
- 412 × 915，深色，同一组页面；
- 915 × 412 窄横屏，四个根模块；
- 600 × 960，1.3 倍字体；
- 840 × 1080，浅色 navigation rail；
- 840 × 1080，深色、1.5 倍字体 navigation rail。

逐张审查导航占位、文字截断、信息层级、颜色、对齐、留白、触摸区域和浮层遮挡。发现并修正两项问题：窄横屏误进入 rail，以及 Android 手势条与底部导航标签相撞。最终矩阵中手机横屏保留底栏，rail 仅在宽度至少 840 dp 且高度至少 600 dp 时启用；底栏、任务条与 snackbar 均包含底部安全区。

## 4. API 35 模拟器验收

设备：`ForeignPressReader_API_35`，x86_64，Android API 35。

- 使用现有本地数据验证真实书库封面、76 篇文章统计与四项导航；未把 EPUB 或截图加入 Git。
- 词典页验证已安装 `standard-v1` 的 59,119 词元/67,810 词形状态、搜索框和“我的生词”分段入口。
- 背单词页验证本地计划、每日 20 个新词、FSRS-6 标识和“开始或继续今日学习”。
- 设置页只展示真实阅读外观与本地产品信息，没有 E4 在线服务、备份或伪成功按钮。
- 切换到设置后强制结束并冷启动，活动 tab 恢复为设置；临时浮层和执行态未恢复。
- 竖屏与 1080 × 2340 设备横屏均完成检查；窄横屏保持四项底部导航，内容没有被系统栏或导航遮挡。
- 在模块根页按 Android Back 后，焦点返回 Pixel Launcher，未跨 tab 跳转。
- 模拟器 `screencap` 在 WebView 硬件合成切换后的个别帧出现黑块；同一 DOM、交互和后续稳定帧正常，确定性 Chromium fixture 不出现该现象，不属于应用渲染缺失。

## 5. 架构与数据审计

- E0 只新增 renderer 内部状态模型、React 产品壳、设计系统和可丢弃 localStorage 快照；没有新增 Tauri command、Rust repository、IPC 或正式 DTO。
- `src/core` 未修改，仍为纯 TypeScript；renderer 仍只经 `AppClient`/受控移动扩展客户端访问能力。
- 未修改 `formal-v1` migration 1、便携备份 format v1、Sync Model v1 或内容 ID v2。
- 快照不保存 API 密钥、密钥草稿、未提交答题、dialog/sheet、选择模式或正在执行的任务，也不进入数据库、便携备份或同步模型。
- 待提交文件审计未发现 EPUB、用户数据库、ECDICT、密钥、备份、日志、截图或构建产物。
- 正式应用仍不读取、迁移或删除旧 Demo 数据。

## 6. 结论与后续

E0 达到正式产品壳、统一设计系统、现有 D 能力重新挂载、可恢复导航状态与多尺寸视觉门禁的退出条件。E1 将在该壳内继续完成书库导入反馈、筛选排序、刊物详情和本地阅读体验的 Windows 能力对齐，不改变本次冻结的一级信息架构。
