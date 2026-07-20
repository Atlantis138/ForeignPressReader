# 外刊阅读器 Tauri Android 移植路线

> 文档状态：正式迁移路线基线
> 起点版本：`v1.0.0-alpha.1`（提交 `7142e40`）
> 适用范围：Electron/Windows 正式应用、Tauri/Android 应用，以及远期 Tauri/iOS
> 最后更新：2026-07-15

## 1. 结论与架构决策

Android 移植是独立于局域网同步的产品主线。阅读、查词、生词和复习的 Android 本地闭环先行完成；局域网同步随后作为阶段 G 接入，仍不属于首个原型的完成条件。

采用“一个产品、一个仓库、共享核心、两个平台外壳”的结构：

- Windows 正式应用继续使用 Electron，不在 Android 原型期迁移到 Tauri。
- Android 在当前仓库增加 Tauri 2 外壳和 Rust/Kotlin 平台适配器，不复制成另一套无关项目。
- `src/core`、逻辑 DTO、稳定 ID、Sync Model、便携格式和领域规则保持平台无关。
- renderer 只调用 `AppClient`。Electron preload/IPC 和 Tauri commands 分别实现同一能力接口。
- 桌面与移动端可以共享领域组件和视觉令牌，但导航、版式、触摸交互及系统生命周期按平台分别设计。
- Android 和 Windows 各自维护本机数据库；跨设备只交换版本化逻辑数据和不含原始 EPUB 的规范化刊物包，不复制 SQLite 文件。
- iOS 复用 Android 阶段形成的 Rust/TypeScript 边界，但实际构建仍需要未来准备 macOS 与 Xcode。

## 2. 当前基线与开发环境

### 2.1 软件基线

- `v1.0.0-alpha.1` 固定正式产品身份、`formal-v1` migration 1、便携 format v1、Sync Model v1 和内容 ID v2。
- 正式 migration 1、便携 format v1 和 Sync Model v1 发布后不可原地改写，只能新增版本。
- Electron 应用是功能和数据语义的对照端，不要求 Android 首版逐像素复制桌面 UI。

### 2.2 2026-07-12 环境快照

- 正式 Git 根目录为 `<repo-root>`；仓库布局与演进规则见[多平台仓库规划](repository-architecture.md)。
- Android Studio 2026.1.1 与 JBR 21 可用；命令行构建使用 JDK 17。
- `ANDROID_HOME` 与 `ANDROID_SDK_ROOT` 指向同一套 Android SDK。
- 已安装 Platform 35/36、Build Tools 36、Platform Tools 37、Command-line Tools、NDK 29 和 Emulator 37.1.7。
- `NDK_HOME` 与 `ANDROID_NDK_HOME` 固定到同一 NDK 29 安装。
- Rust 已安装 `aarch64-linux-android`、`armv7-linux-androideabi`、`i686-linux-android`、`x86_64-linux-android`。
- 一台 Android API 31 ARM64 真机已通过 USB ADB 完成验收。
- API 35 AVD `ForeignPressReader_API_35` 已创建，WHPX 已验证可用并完成无窗口启动、APK 安装和 command 冒烟。
- Tauri CLI/API 已固定为项目依赖：`@tauri-apps/cli 2.11.4`、`@tauri-apps/api 2.11.1`；`Cargo.lock` 当前解析 `tauri 2.11.5`。
- Visual Studio Build Tools 2022（MSVC/Windows SDK）可用；Windows 开发人员模式已启用，供 Tauri CLI 创建 Android JNI 符号链接。
- Gradle wrapper 固定为 8.14.3，下载通过 `distributionSha256Sum` 校验。

## 3. 能力迁移矩阵

| 能力 | 可直接复用 | Android 需要新增或重构 |
| --- | --- | --- |
| 领域规则 | `src/core`、稳定 ID、合并策略、FSRS 语义 | 增加跨 TypeScript/Rust 兼容向量 |
| React 界面 | 领域展示组件、状态模型、视觉令牌 | 移动导航、触摸、返回键、安全区、软键盘和窄屏阅读布局 |
| AppClient | 能力接口与逻辑 DTO | Tauri invoke/event 实现；禁止 renderer 直接访问原生插件 |
| SQLite | `formal-v1` 逻辑结构与迁移行为 | Rust repository、事务、完整性检查、升级和失败回滚 |
| EPUB | 内容 ID、来源 Profile、规范化规则 | Android 文件选择、持久目录、解压/解析执行位置和大文件内存策略 |
| 词典 | 查询语义、词元与展示模型 | Android SQLite 查询、词典包安装、后台线程和资源路径 |
| 学习 | `LexemeKey`、FSRS、队列、学习时钟与事件语义 | Rust 事务仓储、幂等 command、前后台恢复与移动单卡交互 |
| 网络 | `NetworkClient` 端口、供应商适配语义 | Rust/Android HTTP 实现；遵循系统/VPN 网络栈，不复用 Windows 代理发现 |
| 密钥 | `ApiKeyStore` 端口和脱敏规则 | Android Keystore 或受审计的 Tauri 安全存储适配器 |
| 语音 | 播放队列、供应商注册和缓存键 | 验证 WebView 音频；必要时增加 Kotlin 系统 TTS/音频插件 |
| 备份 | 正式 format v2、规范化刊物包、校验和合并规则 | Android 文件创建/选择、原子写入、空间预检和恢复补偿 |
| 同步 | Sync Model v2、revision、墓碑、规范化刊物包和 loopback 测试 | NSD、配对、HTTPS、证书、传输 staging、权限和前后台策略 |

## 4. 实施原则

1. 日常开发与 D0–D3 等子阶段验收以 API 35 模拟器、自动测试和双 ABI 构建为主；华为真机不要求长期在线，统一在 A/B/C/D/E/F 等大阶段结束时集中完成该阶段真机清单。
2. 先建立窄平台端口，再迁移功能；不得在 React 组件中散落 `invoke`、SQL、文件路径或 Android API。
3. 不为追求“代码共享率”强迫桌面和移动端共用不合适的页面结构。
4. 原型只使用测试数据目录和测试 EPUB，不接触真实 Windows 用户数据库。
5. 优先使用 Tauri 官方、支持 Android/iOS 的插件；引入插件前必须验证维护状态、权限面和离线构建。
6. 阶段 B 已选择内部 Rust `rusqlite` bundled repository；不采用向 guest 暴露查询接口的 Tauri SQL 插件，renderer 永远不得获得任意 SQL 能力。
7. 手机上的数据库必须重放与 Windows 相同的逻辑迁移和兼容向量；不能修改 `formal-v1` 来迁就适配器。
8. 每个原生能力都要定义拒绝权限、应用重启、系统回收和中途取消行为。
9. Android 原型通过前不重写 Electron 主进程，不同时进行 Windows Tauri 化。
10. 纵向切片允许使用可验收的薄移动 UI；阶段 E 负责统一信息架构和完整功能覆盖，不以“尚未正式做 UI”为由跳过模拟器交互验证。
11. Windows 与 Android 不追求逐像素一致，但必须对齐产品术语、数据语义、信息层级、状态反馈、危险操作和核心视觉令牌；导航、触摸、返回键、安全区与软键盘遵循各自平台。
12. D2/D3 的薄 UI 应继续复用当前移动端颜色、排版、间距和加载/空/错模式，避免在 E0 前形成第三套临时风格；E0 再系统化完成设计令牌、信息架构和功能覆盖对照。
13. 真机待测项随子阶段追加到[Android 集中真机测试清单](android-device-test-backlog.md)，阶段内不因设备暂时不可用而阻塞可在模拟器和自动测试中可靠推进的工作；大阶段不得在集中真机清单未通过时标记完成。
14. 只有新原生能力、厂商兼容性或真实性能风险已经影响后续架构判断时，才在大阶段中途提前安排专项真机测试。

## 5. 分阶段路线

### 阶段 A：Tauri 真机启动原型（已完成，2026-07-12）

目标：证明当前仓库、Tauri 2、Android Gradle/Rust 工具链和华为 WebView 能形成最小可调试闭环。

交付：

- 从 `v1.0.0-alpha.1` 后的 `main` 建立短期分支 `prototype/tauri-android`。
- 将兼容版本的 `@tauri-apps/cli` 和 `@tauri-apps/api` 固定为项目依赖并提交锁文件。
- 在当前 Vite/React 项目初始化 `src-tauri` 和 Android 工程，保持 Electron 构建脚本继续可用。
- 建立最小 `TauriAppClient`，只提供平台信息、测试目录写读、命令往返和结构化错误。
- 在华为真机安装 debug APK，使用 ADB/logcat 验证启动、热重载、前后台切换和重启。
- 在 API 35 模拟器补跑一次；若加速未恢复，记录为环境任务而不阻塞真机结论。

退出条件：

- Electron 的 `pnpm typecheck`、`pnpm test` 和 `pnpm dist` 不回退。
- `pnpm tauri android dev` 能选择已授权的 ARM64 测试设备并启动应用。
- TypeScript → Tauri command → Rust → TypeScript 往返值一致，错误不会泄露路径或密钥。
- 写入应用数据目录的探针值在进程重启后仍存在。
- 本阶段没有 SQLite、EPUB、词典、学习或同步实现。

验收记录：

- `pnpm tauri:android:dev` 自动识别唯一连接的华为 `OCE-AL50`；不要把 ADB 序列号作为 CLI 的 `DEVICE` 位置参数，否则会被解释为设备名称。
- Tauri Android 会把本地 dev server 代理到 `tauri.localhost/` 并忽略 `devUrl` 的路径部分，因此 Vite 仅在 `TAURI_DEV_HOST` 存在时把根请求重写到独立 `tauri.html`；Electron `pnpm dev` 仍使用桌面 `index.html`。
- 真机完成平台信息、命令往返、结构化错误、固定探针写入、Home 前后台、强制结束和冷启动读回；logcat 只记录命令、结果和错误码。
- Vite HMR 在真机日志显示 connected，并通过临时 CSS 计算样式变化验证；测试样式已撤销。
- API 35 x86_64 模拟器完成安装、启动、命令往返和 Rust command 日志冒烟。
- 静态 debug APK 使用 `src-tauri/tauri.release.conf.json` 加载本地 `tauri.html`，不依赖开发服务器。
- 最终回归通过：`pnpm typecheck`、19 个 TypeScript 测试文件（95 项通过、2 项跳过）、5 项 Rust 测试、零警告 Clippy 和 Windows NSIS 打包。

### 阶段 B：平台基础与数据库（已完成，2026-07-12）

目标：建立后续所有功能依赖的 Android 数据、文件、密钥、日志和网络边界。

交付：

- 将 `AppClient` 的平台无关能力拆成可组合接口，并提供 Electron/Tauri 两套装配入口。
- 实现 Rust SQLite repository，在事务中创建 `formal-v1` 等价结构，执行完整性检查和未知高版本拒绝。
- 建立与 Windows 共用的 schema/DTO 兼容向量：表结构、默认值、稳定 ID、时间戳排序和错误分类。
- 实现应用私有目录、缓存目录、临时 staging 和安全原子替换。
- 实现 Android Keystore/安全存储、脱敏日志和设备本地身份；密钥及设备身份不进入备份。
- 建立 Android `NetworkClient`，验证普通 HTTPS、超时、取消、VPN/系统代理行为和离线错误。

退出条件：首次建库、重启持久化、迁移失败回滚、损坏库拒绝和恢复出厂均有自动测试；Windows 与 Android 对固定兼容向量给出相同逻辑结果。

验证记录：

- 采用 `rusqlite` bundled SQLite，在 Rust 内部事务重放 `formal-v1`；原始 Windows migration 1、便携 format v1、Sync Model v1 与内容 ID v2 均未修改。
- 自动测试覆盖首次建库、空文件初始化、冷启动持久化、完整性检查、事务失败回滚、损坏库、旧 generation 与未知高版本只读拒绝；固定向量同时校验 Windows SQLite 与 Rust 的 schema 指纹、稳定 ID 和版本排序。
- 平台目录区分 data、cache、logs、持久/临时 staging；原子替换只在同目录执行。诊断日志默认关闭，启用后按 JSON Lines 脱敏并轮转。
- Kotlin 插件将不可导出的 Android Keystore AES-256-GCM 根密钥与 no-backup 密文载荷分离；renderer 没有插件 guest 命令或 capability。Android manifest 禁止系统应用数据备份。
- 固定 HTTPS 原生适配器遵循 `ProxySelector` 和 VPN，限制方法、URL、响应大小与超时；真机验证成功、超时、主动取消、离线和非 bypass 系统代理，未发生直连回退。
- 华为 OCE-AL50（API 31、ARM64）完成覆盖安装、数据库/密钥冷启动持久化、密文与日志检查及 debug 恢复出厂；恢复后安装仍在，旧探针与密钥消失，设备身份重新生成。
- API 35 x86_64 AVD 完成安装、首次建库、数据库/Keystore 写入和冷启动读回。ARM64 与 x86_64 原生库 LOAD 段均为 `0x4000`（16 KiB）对齐。
- 最终回归通过：`pnpm typecheck`、21 个 TypeScript 测试文件（99 项通过、2 项跳过）、16 项 Rust 测试、`cargo fmt`、零警告 Clippy、ARM64/x86_64 debug APK 和 Windows NSIS 打包。
- 本阶段未实现 EPUB、词典、生词、FSRS、正式移动 UI、便携备份或局域网同步。

### 阶段 C：本地阅读纵向切片（已完成，2026-07-12）

目标：在 Android 完成“导入一本 EPUB → 阅读 → 定位 → 重启恢复”的最小产品闭环。

交付：

- 使用 Android 系统文件选择器导入无 DRM EPUB，复制到应用私有目录后再解析。
- 先用小型样本验证可行性，再决定解析留在纯 Web Worker、迁到 Rust，或采用混合方案。
- 保持内容 ID v2、来源 Profile、HTML 清理和阅读锚点语义与 Windows 一致。
- 建立移动书库、目录、阅读页、字号/行距/主题和系统返回键行为。
- 处理安全区、横竖屏、软键盘、文字选择、触摸滚动和应用前后台切换。
- 为大 EPUB 建立内存和磁盘基线，避免把完整文件在 Rust、WebView 和 worker 间多次复制。

退出条件：固定样本在两端产生相同内容 ID 和章节顺序；真机可连续阅读、退出并恢复锚点；导入取消、文件损坏和空间不足不会留下半成品。

验证记录：

- 采用混合流式方案：Android `ACTION_GET_CONTENT` 只把所选 EPUB 复制一次到应用私有 staging；Rust 执行 SHA-256、ZIP/CRC/路径/展开量/空间校验、受控图片提取和 SQLite 事务；Web Worker 复用纯 TypeScript 来源 Profile、HTML 清理与内容 ID v2。
- `MobileReadingClient` 只暴露导入会话和逻辑阅读 DTO。renderer 不持有私有绝对路径、任意 SQL、任意文件系统命令或 ZIP 二进制；图片只通过数据库授权的 `reader-asset` GET 协议读取。
- 没有修改 `formal-v1` migration 1、便携 format v1、Sync Model v1 或内容 ID v2。新增 `test-vectors/epub-content-v2.json`，由 TypeScript 解析器与 Rust repository 共同验证稳定 ID 和顺序。
- 华为 OCE-AL50（API 31、ARM64）和 API 35 x86_64 AVD 均以外部 `TheEconomist.2026.07.11.epub` 验证 20 个栏目、76 篇文章和 1,305 个内容块；正文栅格图片通过受控协议正常加载。
- 真机验证系统选择器取消不留 staging、重复导入不增加数据库记录、冷启动后“继续阅读”恢复相同文章及稳定锚点；华为从 420 px 恢复到等价锚点约 411 px，API 35 在可滚动上限处精确恢复约 372 px。
- 自动测试覆盖 camelCase 原生边界、损坏/越界 EPUB、CRC 与入口限制、事务发布失败回滚、解析失败清理、提交中取消、受管孤儿目录、阅读锚点、偏好和跨平台内容向量。详细记录见[阶段 C Android 验证](stage-c-android-validation.md)。
- 最终回归通过：`pnpm typecheck`、22 个 TypeScript 测试文件（104 项通过、2 项跳过）、真实样本单项接受测试、24 项 Rust 测试、`cargo fmt`、零警告 Clippy、ARM64/x86_64 Android debug 构建和 Windows NSIS 打包。
- 本阶段没有实现词典、生词、FSRS、翻译、朗读、便携备份、完整移动 UI 覆盖或局域网同步。

### 阶段 D：词典、生词与复习纵向切片（已完成，2026-07-13）

目标：完成“选词 → 查词 → 加入生词本 → 完成一张复习卡 → 重启后保留”的学习闭环。

阶段 D 不作为一次性大功能实施，必须按以下顺序独立验收：

- **D0：契约、算法归属与资源 spike（已完成，2026-07-12）**——冻结最小 `MobileLearningClient`、错误、兼容向量和 ECDICT manifest；确定共享 TypeScript FSRS/队列计算与 Rust 原子提交边界；双设备验证资源包、WebView 点词、字体、系统 TTS 和音频能力，但不实现正式产品功能。验收见[阶段 D0 Android 验证](stage-d0-android-validation.md)。
- **D1：离线 ECDICT 与点词查词（已完成，2026-07-13）**——支持固定上游源码联网预载和预构建包安装，校验后由 Rust 生成/原子替换 standard-v1；提供英中搜索、Rust 后台只读查询和阅读器 token 薄词典面板，普通查词零写入。API 35 与华为 API 31 均完成固定源、英中搜索、真实文章多候选、连续点词和冷启动复验；记录见[阶段 D1 Android 验证](stage-d1-android-validation.md)。
- **D2：生词与语境（已完成，2026-07-13）**——收藏/取消词条与当前语境、最小生词列表和快照恢复；维护现有 revision、墓碑和跨平台逻辑记录。华为真机完成取消/再收藏、删除词典后的快照、冷启动和覆盖安装审计。
- **D3：最小计划与一张 FSRS 卡（已完成，2026-07-13）**——以“我的生词”为来源创建最小计划，打开今日队列，以 `commandId + expectedVersion` 原子提交一张卡及不可变事件，并验证冷启动和跨日恢复。华为真机完成 revealed 强停恢复、双击冲突、答错后两次认识强化和数据库逐表审计。D2/D3 记录见[阶段 D2–D3 Android 验证](stage-d2-d3-android-validation.md)。

在线翻译、百度词典、远程语音、完整词典中心、完整计划管理和最终移动视觉移入阶段 E，不是阶段 D 的退出条件。D0–D3 的完整交付、停止条件、分支/提交顺序和测试矩阵见[阶段 D0–D3 实施计划](stage-d-learning-slice-plan.md)。

D1 将用户明确要求的“搜索查词”作为受控范围扩展：只提供 standard-v1 英文词元/词形与中文简释搜索、词条详情，不提前实现考试词集浏览、高级筛选、完整定义扩展、百度增强或用户词汇写入。联网预载也不是在线词典服务；网络只用于用户显式安装固定 ECDICT revision，安装后查询完全离线。

退出条件：同一固定操作序列在 Windows/Android 生成兼容的词典、词汇、来源、计划、队列、卡片和事件记录；普通查词不写用户数据；词典资源失败不损坏 `reader.sqlite`；重启、双击、重试或中途退到后台不重复记忆事件；完全离线时本地查词和一张新卡/到期卡复习可用。

### 阶段 E：移动 UI 与功能覆盖

目标：把纵向切片扩展为日常可用的 Android 本地阅读器，在能力、数据语义、状态反馈和产品风格上对齐 Windows，但不把桌面页面直接缩小到手机。

已逐项盘点 Windows Electron 的 `AppClient`、四大模块、阅读器、跨模块状态和真实界面。详细功能账本、移动信息架构、组件清单、架构边界、测试矩阵与提交顺序见[阶段 E Android 完整产品 UI 与 Windows 功能对齐计划](stage-e-mobile-parity-plan.md)。

阶段 E 按模块独立推进；E0/E1 完成后，数据边界相对独立的 E2 与 E3 可以并行开发：

- **E0：产品壳、设计系统与对照账本（已完成，2026-07-13）**——手机四项底部导航、宽屏 navigation rail、独立 tab 栈、系统 Back、正式设计令牌、公共触摸组件、统一任务/空/错/确认模式，以及 Windows/Android 功能账本。
- **E1：我的书库与本地阅读完整对齐（已完成，2026-07-13）**——分类、排序、网格/列表、选择/批量、重命名/删除、导入生命周期、可折叠目录与继续阅读、完整本地排版设置、当前文章搜索和稳定锚点；同步建立六分区设置框架和全局紧凑移动密度。
- **E2：词典与我的生词完整对齐（已完成，2026-07-14）**——已接入词典检索/我的生词双模式、180 ms 防抖与 latest-wins、考试词集、高级筛选、共享完整词条展示、收藏语境和回原文、快速资源状态与运行时缓存；standard/full 资源管理统一位于“设置－词典服务”。百度、AI 文中义、例句翻译和语音由 E4 接通；共享测试、既有 API 35/华为批次与阶段 F 精简集中验收共同关闭设备门禁。
- **E3：背单词完整对齐（已完成，2026-07-14）**——已接入今日 dashboard、new/review/carryover、强化/太简单/改判、额外批次、今日词表、完整计划管理、来源同步、熟练度与 D/S/R、逐词排除/暂停，以及只影响下一批的每日学习参数。共享 TypeScript proposal v2、Rust v1/v2 兼容事务、双 ABI、Windows 分发构建、数据保留和离线冷启动回归通过。
- **E4：设置、翻译、词典增强与语音服务（已完成，2026-07-14）**——已接通正式设置一级页、DeepSeek/OpenAI/Kimi、百度/AI 文中义/例句翻译、系统/Google/MiniMax、学习参数与开发工具、资源/存储、脱敏日志和恢复出厂；自动化、90 场景视觉矩阵、真实供应商脱敏冒烟、双 ABI、Windows NSIS、API 35 基础冒烟与阶段 F 华为集中抽查通过。电话、蓝牙、TalkBack 等扩展设备矩阵降为发布候选非阻断回归。
- **E5：跨模块收口与完整覆盖审计（并入阶段 F 完成，2026-07-14）**——深链、四 tab 快照、全局任务、旋转/字体、进程回收、数据工具、华为 API 31 集中真机，以及 Windows 功能的覆盖或平台化解释均由阶段 F 收口；扩展无障碍和音频附件矩阵不再阻塞 Alpha。

手机一级导航默认固定为“书库、词典、背单词、设置”；“我的生词”归入词典并允许阅读器/学习页直达。文章阅读和全屏答题隐藏一级导航，宽屏设备才切为窄 navigation rail。桌面双栏、hover、快捷键和数据目录等能力分别改为全页详情/sheet、显式菜单、可见按钮和存储/分享界面。

各批次明确 Android 首版暂不支持的桌面功能，不用兼容代码或占位返回伪装成已支持。

退出条件：核心日常流程无需连接 Windows；跨平台对照表无未解释缺口；连续使用无明显导航死路、内容遮挡、状态丢失、反馈语义冲突或不可恢复错误；阶段 F 不再承担基础页面和四大模块功能补齐。

### 阶段 F：收尾、数据工具与 Android 预发布 Alpha（已完成，2026-07-14）

目标：在四大模块主要功能完成后，补齐最后一批设置与平台能力，并把 Android 稳定为可继续迭代的预发布 Alpha。

主要工作：

- 完善设置中的“数据与存储”，新增“开发与调试”，并与 Windows 端现有能力、术语和安全边界对齐。
- 为跨设备同步保留局域网设备发现与增量同步入口，明确标注后续版本开放；阶段 F 不实现真实传输，也不改写 Sync Model v1。
- 完成 Android 预发布 Alpha 的构建、升级和回归准备，清理仅服务旧 Demo、预正式版本或已废弃路径的冗余兼容代码。

当前实现：

- “数据与存储”已接入正式便携 format v2 的 SAF 导出、选择、预览和 `NewerWins` 合并；刊物以不含源 EPUB 的规范化内容包恢复。页面提供应用程序/资源/用户数据/缓存四类统计、重新扫描、安全缓存与 AI 文本缓存分级清理，以及映射到 Android 系统应用存储页的本地目录入口。
- 本段记录阶段 F 完成时的历史状态：“跨设备同步”当时只显示“暂未开放”，没有注册 NSD、局域网权限、socket 或传输 command；阶段 G 已在其后替换该占位。
- 五秒内连续点击“设置”标题十次后，本次运行才显示“开发与调试”；显示入口不会自动启用开发模式，页面离开/进程重启不恢复该路由。学习调试、脱敏日志、诊断分享和恢复出厂继续由 Rust 确认词与开发状态强制门控。
- Android 版本更新为 `1.0.0-alpha.2` / versionCode `1000001`；release 固定 `com.local.foreignpressreader`，永久 debug 固定 `.dev`。稳定签名从仓库外环境变量或忽略的 `keystore.properties` 读取，缺失时 release 失败。
- 正式入口已删除 Prototype、D0 探针、E0/E1 fixture、旧移动壳映射、重复维护客户端和已废弃最小学习 command；拒绝 Demo format v5–v7 和旧 generation 的正式保护继续保留。

本机自动验证已通过 TypeScript 类型检查与全量测试、Rust test/Clippy、Android ARM64+x86_64 debug APK 联合构建、缺失 release 签名拒绝，以及 Windows NSIS 分发构建。API 35 干净模拟器与华为 API 31 随后完成精简集中门禁：双 ABI 安装/同签名覆盖、离线冷启动、数据库/WAL/SHM 保留、SAF 备份往返、四类存储、分级缓存、系统存储页、十击开发入口、诊断分享、字体/横屏和恢复出厂均通过；完整证据记录在[阶段 F Android Alpha 验证](stage-f-android-alpha-validation.md)。

阶段 F 当时尚未配置稳定 release keystore，因此只以永久 `.dev` 身份和稳定 debug 签名验证升级语义，并验证缺少 release 签名时构建必然失败；仓库外稳定签名实装由后续 v1.0 正式发布门禁完成。恶意备份、失败回滚和幂等矩阵由 Rust/TypeScript 自动化承担，不在设备上重复制造每种破坏向量。

`formal-v1` migration 1、便携备份 format v1、Sync Model v1 和内容 ID v2 仍是不可改写基线；当前已通过 migration 2、便携 format v2 与 Sync Model v2 新增演进。产品不导入便携 v1，Sync v1 仅保留内部接收映射。

退出条件：数据与存储、开发与调试及同步占位入口完成对齐，冗余兼容路径完成审计，预发布 Alpha 在华为 API 31 与模拟器 API 35 通过基础安装、覆盖升级、离线和数据保留回归。

### 阶段 G：局域网同步（实现完成，真实设备端到端验收待执行）

目标：在两个本地应用都稳定后，为现有 Sync Model v2 增加真实传输层。

交付与协议细节以[未来同步功能开发路线](future-sync-roadmap.md)为准。借鉴 LocalSend 的发现降级、准备/确认、证书指纹、进度、取消和诊断体验，但不复制其临时文件传输协议，也不让同步传输重新定义阅读/学习数据语义。

当前实现：

- Windows/Electron 使用主进程 DNS-SD 与 HTTPS 服务；Android/Tauri 使用 Kotlin `NsdManager`、页作用域 multicast lock、Rust HTTPS 服务和 Keystore 身份。双方只有进入同步页时才发现和监听。
- 首次配对使用被发现证书固定 HTTPS、相同六位码和双端确认；成功后保存对端设备 ID、证书指纹与对称信任令牌，可在设置中撤销。
- 发送端读取接收端摘要后生成 snapshot/incremental 批次；接收端按实际本机状态预览新增刊物、更新记录、删除刊物和缺失内容包，用户接受后才上传与原子应用。
- 传输只包含 Sync Model v2 逻辑数据和缺失 `.fprpub`，不包含原始 EPUB、数据库、缓存、词典、API 密钥或身份私钥；批次回执支持安全重试，应用阶段不可取消。
- TypeScript 类型/单元测试、Rust 编译与跨语言向量、Kotlin 编译、Windows x64 NSIS 和 Android ARM64 debug APK 已通过。按当前安排未执行真实 Windows ↔ Android 发现、配对、首传、增量、拒绝、断线与重试矩阵，故设备验收状态仍为待完成。

进入条件已满足：阶段 F 完成；Android 本地功能不依赖网络；同步失败不会阻塞阅读、查词或复习。

### 阶段 H：Android 正式版与远期 iOS

Android 正式版至少满足：数据契约稳定、升级可回滚或恢复、核心流程长期可用、权限最小化、release keystore 安全备份、已知限制明确。个人使用不要求应用商店发布，但仍要保留可重复构建和签名能力。

iOS 开始前复核所有 Android 原生实现：Rust repository 和领域逻辑应可复用；Kotlin 专用能力必须已有平台端口，才能增加 Swift 实现。iOS 构建、签名和真机调试需要 Mac、Xcode 和 Apple 开发配置，不能在当前 Windows 环境完成。

## 6. 测试与提交纪律

每个 Android 大阶段至少包含：

- 现有 TypeScript 类型检查与全量测试。
- Rust `cargo test`、`cargo clippy` 和 Android target 编译。
- 固定跨平台兼容向量，不以人工观察代替数据契约测试。
- 子阶段日常使用 API 35 模拟器完成冷启动、重启、强制结束、断网、拒绝权限、窄屏和交互回归。
- 各子阶段把 ARM/API 31、Huawei WebView、真实触摸、系统选择器、Keystore/代理、后台回收和真实性能项目追加到所属大阶段的真机待测清单。
- 大阶段末集中执行华为真机清单；未通过时该大阶段保持未完成，但不要求真机在整个开发周期长期连接。
- 涉及 UI 时，模拟器持续检查布局和状态；大阶段真机批次补查 API 31、窄屏、横屏、系统字体、触摸滚动和输入法差异。
- 涉及不可再生数据时同步更新 migration、便携备份、恢复和幂等测试。

提交应按阶段拆分，避免把脚手架、数据库、完整移动 UI 和同步塞进一次提交。每个阶段退出后在 CHANGELOG 记录已验证能力和明确未实现项。

所有尚未执行的硬件项目集中维护在[Android 集中真机测试清单](android-device-test-backlog.md)；子阶段验证文档保留详细证据，不再各自承担调度入口。

## 7. 下一任务清单

阶段 A–F 已完成，阶段 G 的局域网同步实现与构建门禁也已完成。下一项同步任务是执行真实 Windows ↔ Android 端到端矩阵并据结果补齐防火墙、AP isolation、权限拒绝和厂商网络栈诊断；按当前安排这项验证暂缓。parsed-only 刊物存储、migration 2、便携 format v2、Sync Model v2 与缓存隔离已纳入当前基线；稳定签名 release、全设备无障碍/音频附件矩阵仍在发布候选执行。

## 8. 官方参考

- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/)
- [Tauri mobile development](https://v2.tauri.app/develop/)
- [Tauri official plugin support](https://v2.tauri.app/plugin/)
- [Tauri SQL plugin](https://v2.tauri.app/plugin/sql/)
- [Android hardware device testing](https://developer.android.com/studio/run/device)
- [Android virtual devices](https://developer.android.com/studio/run/managing-avds)
- [LocalSend](https://github.com/localsend/localsend)
- [LocalSend protocol](https://github.com/localsend/protocol)
