# 阶段 D1 Android 验证记录

> 日期：2026-07-12  
> 分支：`codex/android-offline-dictionary`  
> 状态：实现完成；API 35 与完整固定源验收通过；华为 API 31 修正版复验纳入阶段 D 集中真机清单

## 1. 范围与结论

D1 已完成以下只读纵向切片：

- 用户显式联网预载固定 [ECDICT](https://github.com/skywind3000/ECDICT) revision，或通过 Android 系统选择器安装预构建 `.fprdict`。
- 英文词元/词形搜索、中文简释 FTS 搜索、词条详情。
- 阶段 C 阅读器英文分词、点击查词、词形候选切换、句子/段落上下文与 Android Back。
- 查询取消、陈旧响应抑制、冷启动持久化和可再生词典资源删除。

没有实现生词/语境写入、计划、FSRS、百度增强、在线翻译、远程语音、完整定义扩展、考试词集或局域网同步。`formal-v1` migration 1、便携 format v1、Sync Model v1 和内容 ID v2 均未修改。

## 2. 固定数据源与供应链边界

| 项目 | 固定值 |
| --- | --- |
| ECDICT commit | `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b` |
| `ecdict.csv` | 65,933,428 字节；Git blob `c4ade63ea08cf39d9c3475e96929036d64d94c94` |
| `lemma.en.txt` | 2,318,694 字节；Git blob `34eabb9f48c5867a91c01c33b206120e275f0418` |
| 允许来源 | 固定 commit 的 GitHub raw URL，以及 `ghproxy.net` / `ghfast.top` 两项固定镜像 |

Kotlin 原生插件只接受 Rust 传入的固定 URL、精确字节数、blob SHA 和应用私有 staging 目标；使用系统 `ProxySelector`、HTTPS、连接/读取超时和 64 KiB 缓冲流式写入。大小或 blob SHA 不符、非白名单 URL、取消和下载失败均删除临时文件。renderer 不接收或提交 URL、路径、SQL、SHA 或原生插件命令。

Rust 在相同安装会话的私有 staging 中流式解析 CSV，按 Windows `standard-v1` 规则生成 schema v4 SQLite、词形、标签、词集和中文 FTS；执行 `quick_check`、metadata/计数/映射摘要校验后，才在同卷原子发布。失败与取消不发布半成品；删除只作用于 `dictionaries/ecdict-base` 可再生资源。

## 3. Windows/Rust 完整源兼容对照

同一组仓库外固定源分别交给现有 Windows `dictionary-worker` 和 Rust `dictionary_builder`。首次对照发现 Rust 对 `lemma.en.txt` 的行匹配过宽，额外产生 2,311 个词形；收紧为与 Windows 相同的 `lemma/数字 -> forms` 规则后，对照通过：

| 指标 | Windows worker | Rust builder |
| --- | ---: | ---: |
| ECDICT 原始记录 | 770,611 | 770,611（同一输入） |
| standard-v1 条目 | 59,137 | 59,137 |
| 稳定词元 | 59,119 | 59,119 |
| 词形 | 67,810 | 67,810 |
| `lexemeMapHash` | `b6e911b3adf4bc06f7cc7645868dad846a5eefd560f4e455d0245640d2590a8f` | 相同 |

仓库增加了默认忽略的完整源测试 `matches_the_pinned_windows_standard_profile`。只有显式提供仓库外 `FPR_ECDICT_CSV` / `FPR_ECDICT_LEMMA` 时运行；真实 ECDICT 文件和生成数据库不进入 Git。

## 4. 自动测试

| 层 | 覆盖 |
| --- | --- |
| Rust builder/pack | 小型源构建、manifest/schema/hash/计数、空间预检、原子发布、无效替换保留旧包、故障注入 |
| Rust query | 精确词、保守词形、固定 D0 候选顺序、多候选、未命中、英文/中文搜索、详情和阅读 token 上下文校验 |
| Rust runtime | 安装串行化、查询取消与 request 生命周期 |
| TypeScript client | 固定 D1 commands、内部 UUID、自动取消旧查询，以及 renderer 不提交路径、URL 或 SQL |
| 完整固定源 | Windows/Rust 计数、词形与 `lexemeMapHash` 一致 |

最终回归为 25 个 TypeScript 测试文件、112 项通过、2 项跳过；Rust 默认 35 项通过、1 项完整源测试按设计忽略，完整固定源显式测试另有 1 项通过；`cargo fmt`、零警告 Clippy、ARM64/x86_64 Android debug 构建和 Windows NSIS 打包均通过。

## 5. API 35 x86_64 验收

设备：`ForeignPressReader_API_35`，Android API 35，x86_64，无窗口 WHPX AVD。

### 5.1 联网预载与资源生命周期

- 先验证联网预载取消：页面返回“词典预载已取消”，词典目录和 `.staging/dictionary-packs` 均无文件；同时修复取消后残留“正在下载”提示的 UI 状态。
- 修正版完整预载成功：先下载两项固定源，再在私有 staging 建库，最后清空 staging 并发布。
- 冷启动后 manifest、数据库文件和 UI 状态保持。

修正版发布结果：

| 字段 | 值 |
| --- | --- |
| `entryCount`（稳定词元） | 59,119 |
| 实际 `entries` | 59,137 |
| `formCount` | 67,810 |
| SQLite 字节数 | 25,124,864 |
| SQLite SHA-256 | `99e6014025e3050ad9659fc1c375ad4977702dc2cd9de75d21da709bf68921ce` |
| `lexemeMapHash` | `b6e911b3adf4bc06f7cc7645868dad846a5eefd560f4e455d0245640d2590a8f` |

### 5.2 搜索与阅读器

- 英文 `run` 返回精确词元、词形和前缀结果；中文“跑步”返回 `run`、`runner`、`trotter`，匹配类型为中文释义。
- 外部 `TheEconomist.2026.07.11.epub` 的真实文章中点击 `fighting`，返回 `fighting` 精确词元与 `fight` 词形候选、词性分组、简释和完整句子上下文。
- 查询前后用户库保持不变：
  - `reader.sqlite`：`d3f320e001cbbfa56d5af5705d94ab69bb7f2e624d0aea0797f11c3eee9d4d4a`
  - `reader.sqlite-wal`：`28cb36661737887d53bceb6e2cfa4245493df7d5e213cd7e0af06389f073cf80`

## 6. 华为 API 31 ARM64 已完成项与阶段 D 待测清单

设备：Huawei OCE-AL50，Android API 31，ARM64，Huawei WebView 114。

在发现词形解析偏差前，真机已完成完整固定源联网下载/校验/建库、英中搜索、真实 EPUB `fighting → fight` 候选、101 次快速连续点击、Android Back、强制结束/冷启动和资源持久化。快速点击最终只显示最后的 `futile`；查询前后以下哈希不变：

- `reader.sqlite`：`327a2d97aca4a2f4cfe382da8a60130619b4d348760ed08caa971e2c54754cb1`
- `reader.sqlite-wal`：`2c2a2eb34d0c76dc5134a09c5b6fc00112319ea6258c34acb7933f1f1ab095bb`

该次真机资源含 70,121 个词形，随后已由完整源对照定位并修复；因此阶段 D 完成前仍须用修正版复验。修正版 ARM64 APK 已构建通过，以下项目已同步到[Android 集中真机测试清单](android-device-test-backlog.md)，与 D2/D3 真机项一起在阶段 D 末执行：

1. 覆盖安装修正版 APK，确认书库与 `reader.sqlite` 保留。
2. 删除旧可再生词典并联网预载；核对 59,119 词元、67,810 词形和固定映射摘要。
3. 搜索 `run` 与中文“跑步”，在真实 EPUB 点击 `fighting` 并切换 `fight`。
4. 连续点击 100 次，最后点击 `futile`；确认无串结果或崩溃。
5. 比较点词前后用户库/WAL 哈希，测试 Back、强制结束和冷启动。

上述项目不阻塞 D2/D3 的自动测试和 API 35 开发，但未通过前不得把整个阶段 D 标记完成或进入阶段 E。

## 7. 构建与环境说明

- ARM64 与 x86_64 debug APK 均由 Tauri 2 / NDK 29 构建成功；Kotlin 下载插件已在两种 ABI 的 Gradle 构建中编译。
- Gradle 8.14.3 仍报告面向 Gradle 9 的既有 deprecated-feature 提示，本阶段没有 Gradle 构建失败。
- 真机临时离线不阻塞 D2/D3 代码、自动测试、API 35、Windows 回归或文档；第 6 节项目进入阶段 D 统一真机批次。
