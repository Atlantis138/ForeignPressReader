# 阶段 F Android 预发布 Alpha 验证记录

> 日期：2026-07-14
> 分支：`codex/android-offline-dictionary`
> 起始提交：`98873ab`
> 目标版本：`1.0.0-alpha.2` / Android `versionCode 1000001`
> 状态：已完成；本机编译门禁与 API 35/华为 API 31 精简集中验收通过
>
> 历史说明：本文记录阶段 F 当时的 format v1 验收。当前版本使用不含原始 EPUB 的便携 format v2 与 schema migration 2；当前数据政策以 README 和未来同步路线为准。
> 后续说明：阶段 G 已把本文记录的同步占位替换为 Windows/Android 前台局域网同步实现；自动化、Rust/Kotlin 与 Android ARM64 构建已通过，真实双设备端到端验收按当前安排暂未执行。

## 1. 本阶段边界

阶段 F 只完成 Android 移植收尾与 Alpha 起点，不实现真实局域网同步，也不改写以下正式基线：

- `formal-v1` migration 1；
- 便携备份 format v1；
- Sync Model v1；
- 内容 ID v2。

`1.0.0-alpha.2` 是 Android 后续数据演进的支持起点。正式应用不读取、迁移或删除旧 Demo 数据，不接受 Demo format v5–v7；旧 `.debug` 默认保持原样，只有用户显式设备操作才可处理。

## 2. 数据与存储

Android 新增版本化 `MobilePlatformServices v1`，renderer 只调用逻辑客户端，不接触私有路径、SQLite、Android API 或任意文件系统。

便携备份：

- 导出通过 Android Storage Access Framework 让用户选择目标，包含原始 EPUB 与 format v1 的 18 类正式逻辑数据；不包含活动学习队列、同步元数据、密钥、开发状态、日志、词典或缓存。
- 导入先复制到私有 staging，限制 20 GiB archive、10,000 entries、2,000 倍展开比，逐项校验允许清单、SHA-256、manifest、正式 schema 与内容 ID。
- EPUB 继续交给既有 Web Worker 和共享 TypeScript Profile/消毒/内容 ID v2 解析；确认前只生成预览，不修改正式库。
- 确认后先建立通过 `quick_check` 的 SQLite 安全备份，最多保留 5 份，再在事务中按 format v1 `NewerWins`、不可变事件并集与进度重置语义合并。
- 取消、预览丢弃、校验失败与解析失败清理受管 staging；未知文件、损坏哈希、未知高版本和 Demo manifest 明确拒绝。

存储页按“应用程序、资源、用户数据、缓存”四类展示总量与明细。安全缓存可直接清理；文章译文与 AI 文中义需要独立确认；“本地数据目录”在 Android 映射到系统应用存储页，不向 renderer 暴露路径。

“跨设备同步”只显示后续局域网发现/增量同步说明和“暂未开放”状态。本阶段没有 NSD、局域网权限、socket、证书、配对或同步传输 command。

## 3. 开发与调试

- 五秒窗口内连续点击“设置”标题十次，才在本次运行显示“开发与调试”。
- 显示入口不会自动启用开发模式；隐藏页路由不会写入移动壳快照，进程重启后重新隐藏。
- 开发模式关闭时同时关闭诊断日志；日志最多保留 5 个脱敏文件，可经受限 FileProvider 分享诊断包。
- 模拟下一学习日、全量学习进度重置和恢复出厂使用固定确认词，并在 Rust 再次检查开发状态。
- 恢复出厂只清除当前 Android application ID 的私有数据，不读取、迁移或删除 Windows 与旧 Demo 数据。

## 4. Alpha 身份、签名与断代清理

- release：`com.local.foreignpressreader`；debug：`com.local.foreignpressreader.dev`。
- release keystore 只能通过 `FPR_ANDROID_KEYSTORE_*` 环境变量或已忽略的 `src-tauri/gen/android/keystore.properties` 提供；仓库只保留无秘密示例。缺少签名时 release task 立即失败。
- 移动壳 key 重置为 `fpr.android.alpha.shell.v1`，不保留旧 key/version mapper。
- 正式 Tauri 入口只渲染 `MobileReadingApp`；已删除 Prototype/Stage A-B 诊断 UI、D0 WebView/词典探针、E0/E1 fixture 与捕获脚本、旧 `TauriAppClient`、重复维护客户端和已废弃最小学习 command。
- D0 学习/内容兼容向量中仍被正式契约使用的稳定算法测试没有改写；Demo/未知 generation/高版本拒绝保护没有删除。

## 5. 自动验证证据

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck` | 通过 | core、renderer、Electron 三条 TypeScript 配置通过 |
| `cargo check` | 通过 | `foreign-press-reader 1.0.0-alpha.2`，无 warning |
| `gradlew :app:compileArm64DebugKotlin` | 通过 | SAF、系统存储页、包体统计与插件 command 可编译；仅本机 SDK XML 工具版本提示 |
| `pnpm vitest run tests/mobile-shell-model.test.ts` | 通过 | 12 项，含 Alpha shell 与会话级开发页不持久化 |
| `pnpm test` | 通过 | renderer/Electron 构建成功；34 个测试文件，169 项通过、2 项按既有条件跳过 |
| `cargo test` | 通过 | 60 项通过、1 项需仓库外固定 ECDICT 源的既有测试忽略 |
| `cargo clippy --all-targets -- -D warnings` | 通过 | 所有 Rust target 零 warning |
| `gradlew :app:compileArm64ReleaseKotlin`（无签名配置） | 按预期拒绝 | task graph 在编译前明确报告 release signing 未配置 |
| `pnpm dist` | 通过 | 生成 `ForeignPressReader-1.0.0-alpha.2-Setup.exe` 与 blockmap |
| `pnpm tauri android build --debug --target aarch64 x86_64 --apk --ci` | 通过 | Android Rust targets、Kotlin 插件、正式移动入口与双 ABI universal debug APK 联合构建成功；仅既有 Android 音频焦点/Gradle deprecated 提示 |

完成最终命令后应更新本表，不用设备观察替代自动门禁。

## 6. 精简集中门禁策略

本轮按“自动化验证数据语义，设备验证 Android 桥接”的原则收口，避免在两台设备上重复制造所有恶意 ZIP、故障注入和完整视觉组合：

- Rust/TypeScript 自动化负责 format v1 的 18 类数据、`NewerWins`、不可变事件、幂等、Demo/未来版本拒绝、路径穿越、哈希、条目/展开限制、事务回滚和安全缓存边界。
- API 35 与华为设备只验证自动化不能替代的安装/覆盖、ABI、WebView、SAF、系统设置 Intent、离线冷启动、会话隐藏、分享 Intent、字体/旋转和应用级清除。
- 稳定 release keystore 未配置；实际稳定签名安装留作发布候选门禁。本阶段以永久 `.dev` identity 和同一 debug 签名验证覆盖升级，同时确认无签名的 release task 在编译前拒绝。
- 电话、蓝牙、TalkBack、90 场景全量截图等扩展矩阵不再阻塞预发布 Alpha，继续作为发布候选回归。

## 7. 设备结果（2026-07-14）

测试包为双 ABI universal debug APK，SHA-256 `058D9326015C144CD8E2BC37B1A9D4AF429E18DC21C40B2E668E596EEF09C4C8`。

### API 35 x86_64 模拟器

- 对 `ForeignPressReader_API_35` 执行 `-wipe-data` 干净启动，安装 `com.local.foreignpressreader.dev`，系统报告 `versionCode 1000001`、`versionName 1.0.0-alpha.2`、`primaryCpuAbi=x86_64`。
- 关闭网络后冷启动并走查书库、词典、背单词、设置；正式 Activity 保持前台，无应用崩溃。
- 数据与存储页、四类统计、十击解锁和开发页正常；重启后开发入口重新隐藏。
- 使用同一 APK 覆盖安装，`reader.sqlite`、WAL 与 SHM 的 SHA-256 均保持一致，版本与 ABI 不变。

### Huawei OCE-AL50 / API 31 / ARM64 / Huawei WebView 114

- 按用户明确要求先由 ADB 显式卸载旧 `com.local.foreignpressreader.debug`；正式应用代码没有读取、迁移或删除旧身份。随后干净安装 `.dev`，系统报告 `versionCode 1000001`、`versionName 1.0.0-alpha.2`、`primaryCpuAbi=arm64-v8a`。
- 离线冷启动和四个一级入口可用；同签名覆盖安装前后 `reader.sqlite`、WAL 与 SHM 哈希逐项一致。重启后开发入口重新隐藏，再次十击后已启用的开发/日志状态仍保留。
- SAF 成功导出 3,200 字节 format v1，选择同一文件后显示创建时间、刊物/生词/计划计数与 `NewerWins` 预览，合并恢复成功。空数据设备只验证原生桥接；18 类非空数据、重复导入和失败回滚由自动化门禁验证。
- 存储页成功显示四类统计并重新扫描；安全缓存直接清理、AI 文本缓存经独立确认清理，系统应用存储详情页正常打开。诊断日志开关与受限分享 chooser 正常。
- 五秒内十击成功显示开发页；空数据执行“模拟下一学习日”返回“尚无今日学习会话”的受控业务错误，没有崩溃。固定确认词和事务行为由自动化覆盖。
- 在 `.dev` 测试数据上执行“格式化并自动重启”后，私有数据库、迁移备份与诊断包均被删除，application ID 仍安装；外部备份 SHA-256 保持不变。离线重启创建新正式库，再从 SAF 预览并恢复成功。
- 1.3 倍系统字体与强制横屏下数据/存储主操作仍可见并可滚动；测试后字体、自动旋转、Wi-Fi 和移动数据均恢复原值。
- 设备 crash buffer 未发现 `com.local.foreignpressreader.dev` 崩溃；本轮创建的外部测试备份已删除，真实 EPUB、数据库、ECDICT、密钥、备份、APK 与截图均未进入 Git。

以上结果关闭阶段 E2–E5 与阶段 F 的 Alpha 集中门禁。稳定签名 release 和扩展无障碍/音频附件矩阵仍是发布候选任务，不回开阶段 F。
