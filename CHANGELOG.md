# Changelog

## Unreleased

### Added

- Windows/Android 目录新增栏目、文章标题与摘要翻译，支持显示/隐藏、取消、失败续译和重新翻译；结果按目录内容、模型和提示词版本保存在本机磁盘缓存，重启后可复用。长目录进入文章或切换主页面后可恢复滚动位置。
- Windows/Android 翻译设置支持填写、保存和删除按供应商区分的自定义模型 ID；自定义服务配置只保存在本机，不进入便携备份或局域网同步，兼容此前的 Windows 本机配置。
- Windows/Android 新增每篇文章独立的持久阅读位置、书签、已读状态与分页全文检索。FTS 索引可从正文重建，用户阅读记录随备份和同步保留。
- 译文可保留多个版本、选择查看；重新翻译自动保留前后版本。版本按内容确定身份，清理缓存不删除保留版本。
- 新增顺序 migration 4、便携格式 v4 和 Sync Model v4；冻结既有 migration/向量，保留 v2/v3 便携恢复与旧逻辑批次校验。新版 LAN 只与相同模型版本通信。
- 同步接收页增加逐项、分页的本机/接收后摘要；准备、预览和应用只投影选中实体。v4 用可失效缓存的解析内容摘要识别同源 EPUB 的内容补全。
- 再次导入相同原始 EPUB 可补回遗漏章节/文章/段落，保留旧 ID、阅读和学习记录；内容身份冲突时回滚。补全内容也可传给已经持有同源刊物的设备。
- Windows 启动失败可选择正式 SQLite 快照；Android 启动失败可选择本机内部快照。先在临时目录验证/升级，替换时保留原数据库和 sidecar 文件。
- Android 文章朗读移入原生前台媒体服务，系统 TTS 和远程音频队列不依赖 WebView 定时器推进；增加暂停、继续、上一段、下一段和停止通知动作，以及音频焦点与耳机拔出处理。
- 阅读记录、内容修复、启动恢复、共享阅读控件和变更明细拆成独立模块；共用规范 JSON 实现，避免在同步与学习中重复维护。


### Fixed

- 修复桌面语音服务图标不随主题变色的问题，与 Android 统一使用线条图标；状态标签保持横排，同步详情的卡片、配对提示、操作状态和变更分页适配深浅主题。
- Windows/Android 文章译文字号跟随正文字号设置，阅读工具栏与外观设置均生效。
- 目录缓存不再受进程内 8 项限制；逐项保存部分译文，原子替换文件，损坏缓存可重新生成。缓存纳入 AI 文本存储统计和清理，安全缓存清理会保留目录译文，取消/清理后的旧响应不会写回。
- Android 翻译补齐漏项重试、重复 ID 去重、临时网络错误重试与取消检查；正文和目录复用同一批次实现。模型连接测试使用表单当前选择。
- 修复同一刊物身份、不同文件内容的导入/恢复失败时误删既有资源目录的问题；重复导入相同源文件可补回缺失图片，保留阅读和学习数据。
- 便携合并提交后，清理已删除刊物的残留文件失败不再回收本次已成功恢复的刊物，也不会把临时目录清理失败当作导入失败。
- 修复 Android 缓存失效期间旧请求重新写回缓存、阅读外观连续保存时旧响应覆盖新值、翻译任务读取密钥期间重复启动的问题；保存失败会恢复已保存外观。
- Windows 与 Android 的重新翻译按钮可强制重新请求全文；切换模型后仍可查看正文摘要匹配的已有译文，生成新译文仍按当前模型独立缓存。
- 补全短文、div 等普通容器内正文和表格单元格文本的 EPUB 导入；既有内容 ID v2 算法及向量保持不变，表格当前按文字阅读，不保留表格布局。
- 为学习首页、今日词表、Android 学习设置、书库及文章加载失败补充重试；忽略过期的筛选和文章请求，今日词表支持超过 100 项的分页。
- 普通模式可以删除学习计划并保留已有词汇进度；重置进度仍须开启开发模式。修复最后一张卡“太简单”的撤销入口消失，以及 Android 标记失败仍显示成功撤销提示的问题。
- 增加页面错误兜底、Windows 渲染进程异常后的重新加载入口，区分数据库损坏/无法访问与旧 Demo 数据；学习弹窗与移动端通用弹窗补充键盘焦点管理。
- Android 系统 TTS 在前台连续朗读时复用引擎，并隔离旧语音回调；离开前台时释放资源。

- 修复接收端应用“删除学习计划”或全局/逐词进度重置后，设备本地活动 session 与临时队列仍引用已删除数据的问题；Windows 与 Android 现在都会在同一事务内清理失效队列并结束空 session，Android 也会正确执行只有全局墓碑、没有逐词墓碑的重置批次。
- 接收同步或确认便携导入后，两端 renderer 会立即失效学习 dashboard 缓存并刷新书库、阅读外观及各类逻辑设置；移动端同时退出可能已失效的刊物、文章、词条、计划和学习 session 深层路由，计划详情加载失败不再永久显示骨架屏。
- 发送端恢复接收端曾删除的刊物时，会把因接收端级联删除而消失的阅读位置作为依赖记录一并重发，避免正文恢复但进度丢失。

### Changed

- Windows/Android 书库的文章与阅读记录入口移到管理工具栏，默认折叠为小按钮，展开后仍可搜索正文及筛选书签、已读与未读；页面标题恢复顶部位置。
- `pnpm dev` 自动编译主进程/预加载，并在其源文件修改后重新编译和重启；新增 `test:unit` 跳过 Electron UI 启动和 renderer 构建，完整 `pnpm test` 保持可独立运行。CI 复用完整测试的构建结果执行协议检查，移除重复构建。
- 展开学习页面、阅读页面和学习存储模块的超长行；用实际交互回归替换部分源码字符串/像素常量检查，移除对产品版本号 `1.0.0` 的固定锁定。详见 [项目修复记录](docs/project-repair-2026-09.md)。
- 新增顺序 migration 3、便携备份 format v3 与 Sync Model v3：分类、自定义刊名和归类关系改为带稳定 ID 与删除墓碑的细粒度记录，接收端独有分类/刊名不再因另一端整个 `library.management` JSON 覆盖而丢失；`library.management` 只保留为 UI/旧备份兼容镜像，不再进入 v3 局域网批次或制造界面筛选变化 revision。
- 保留正式 migration 1、便携 format v1、Sync Model v1、内容 ID v2 和既有 Sync Model v2 向量不变；当前版本可把 format v2 备份及 v2 同步记录映射到 v3，未知高版本仍明确拒绝。
- 收紧两端批次 envelope、记录数量、revision 范围、刊物包描述和刊物 ID 校验，阻止不安全 ID 被用于刊物 staging 路径。

### Tests

- 新增 Windows/Android 共享 v3 数据库与 Sync Model 向量，以及全同步记录族往返、计划删除、全局重置、细粒度书库墓碑、刊物恢复阅读位置、format v2 升级、迁移失败回滚、恶意刊物 ID 和接收后 UI 刷新的回归测试。

### Verification

- 2026-10-03 Windows x64 `pnpm dist` 与打包协议检查通过；按用户请求覆盖安装到原用户级目录，安装文件与本次构建一致，启动前原数据库校验值未变，已启动新版应用。版本号仍为 1.0.0，详见 [双端对齐验证](docs/cross-platform-parity-2026-10.md)。
- 2026-10 双端目录缓存与功能对齐：类型/lint、完整 TypeScript 260 项（3 项跳过）、Rust 94 项（1 项忽略）、Clippy、Android ARM64 编译和跨运行时便携互操作通过；真实 Electron 重启缓存读回与移动窄屏/深色界面检查通过。范围及真机限制见 [双端对齐验证](docs/cross-platform-parity-2026-10.md)。
- Windows 目录与翻译更新：`pnpm typecheck`、`pnpm lint`、`pnpm test` 通过，253 项通过、3 项按环境跳过；长目录返回位置、译文字号及自定义模型交互经 Electron 验证，详见 [验证记录](docs/desktop-translation-validation.md)。
- 本轮缺陷修复：TypeScript 235 项通过（3 项按环境跳过）、Rust 87 项通过（1 项需要外部词典源文件而忽略）、Android 插件 14 项 JVM 测试通过；类型、lint、备份互操作、协议安全探针及开发启动/重启冒烟通过。范围与人工验证限制见 [项目修复记录](docs/project-repair-2026-09.md)。
- `pnpm typecheck`、`pnpm lint`、`pnpm test` 与 `pnpm test:interop` 通过；全量 TypeScript 为 44 个测试文件通过、1 个按环境跳过，223 项通过、3 项跳过，跨 TypeScript/Rust 便携数据互操作 1 项通过。
- Rust `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 与 `cargo test --all-targets` 通过；87 项通过、1 项因需要仓库外固定 ECDICT 源文件而按设计忽略。

## 1.0.0 - 2026-07-20

### Added

- 将 Windows 侧栏原有的宋体“外”字固化为无字体依赖的矢量轮廓，并由同一红底白字母版生成桌面侧栏、Windows 与 Android 正式图标。
- 新增 `2026 Atlantis138` 的 MIT License、正式版安装说明与公开发布边界。
- 新增 ECDICT 独立第三方许可声明，并在两端词典服务界面标明 `skywind3000/ECDICT · MIT`；安装包与 Release 仍不捆绑词典数据。

### Changed

- README 收敛为面向使用者的项目首页；历史性能数据、Alpha 过程、协议常量和内部维护规则继续保存在 CHANGELOG、验证记录与 AGENTS.md。
- renderer 收敛为非序列化的统一 `AppClient` 能力表，移动 UI 只持有一个组合实例；Android 独有应用信息、SAF 清理和系统存储入口集中到 `platform` 扩展，Electron preload/IPC 与 Tauri invoke/event 形状不变。
- 按领域机械拆分移动壳、移动 CSS、Rust 学习/同步运行时及 102 个 Tauri commands；通过 facade 与装配测试保持公开函数路径和 command 名称不变，正式数据库、便携备份、Sync Model、Wire 与内容 ID 契约不变。
- 删除仅服务 Alpha 的数据库探针、可再生旧缓存迁移与无调用兼容层；不删除正式版本化兼容逻辑。

### Distribution

- 正式 Android 身份保持 `com.local.foreignpressreader`，版本码升级为 `1000006`，使用仓库外 RSA-4096 稳定 keystore 构建 ARM64/R8 release APK；Windows x64 安装包按个人使用计划暂不做 Authenticode。
- 仓库以 `Atlantis138` 署名采用 MIT 许可公开；发布说明明确当前 EPUB 兼容范围、个人自用定位和不捆绑任何刊物内容的边界。

### Verification

- GitHub Actions 统一从 `packageManager` 读取 pnpm 版本，为两个 Linux Rust runner 安装 Tauri 官方系统依赖，保留 Android Gradle wrapper 的可执行位，在 Android JVM 检查前根据锁定的 Cargo metadata 重建被忽略的机器相关 Tauri Gradle 装配文件，并让 Windows runner 按正式学习向量声明的 `Asia/Shanghai` 时区执行 Node 测试、在并行测试前准备 Electron runtime，避免干净 runner 因环境差异或临时下载争用误报。
- `pnpm typecheck`、`pnpm lint`、`pnpm audit:prod`、`pnpm test`、`pnpm test:interop`、源码/打包 Electron 协议冒烟、Rust `fmt` / 零警告 `clippy` / `cargo test --all-targets` / RustSec 依赖审计、Android 平台插件 Kotlin/JVM 门禁、`pnpm perf:smoke`、`pnpm dist` 与 Android ARM64 release 构建通过。TypeScript 为 44 个测试文件通过、1 个跳过，213 项通过、3 项跳过；Rust 为 78 项通过、1 项按设计忽略。
- 最终性能 smoke：冷启动 232.21 MiB、文章 305.62 MiB、词典 333.26 MiB；最后十次切换增长 1.03%，回收后 renderer 堆增加 0.14 MiB，闲置 CPU 0.03%，EPUB 文件快速路径峰值降低 54.87%。
- Windows x64 NSIS 为 99,013,606 bytes，SHA-256 `278E51EF656F3ABD2D16A33270D2578AC3D56865931C09272C0FBF1EBD53308F`，核对为未做 Authenticode。Android ARM64 APK 为 27,916,422 bytes，SHA-256 `BEACE0BA93B0F27F29AAA999D16A5A439EEA1E4CDEF76BA7C93B758E93E2DA55`；核对为正式身份、R8、无 debuggable 属性、仅 `arm64-v8a`、APK v2 单一签名、RSA-4096 稳定证书并通过 16 KiB page zipalign。

## 1.0.0-alpha.6 - 2026-07-20

### Fixed

- Android 局域网发现现在按 Wi-Fi/以太网逐接口绑定物理网络，排除蜂窝网络与 VPN；组播、广播、NSD 和并发上限为 12 的 `/24` 验证器都有独立健康状态与完整停止清理。任一可用通道恢复后会清除旧失败；已经发现设备时只显示非阻塞的“部分发现能力受限”，只有所有通道均不可用时才显示告警，renderer 不再泄露原生英文诊断。真实 Windows → Android 传输后的“无法完整发现设备”误导提示因此不再长期残留。
- 修复 Android 冷启动首屏并发原生命令在 Huawei API 31 WebView 上偶发丢失回调的问题；此前会留下永久“正在处理”进度线，或把仍有 14 本刊物的书库暂时显示为空。首载改为顺序只读、限时重试和加载骨架，连续 12 次冷启动均恢复完整书库且进度线正常结束。
- 修复“今日学习”打开队列时使用了 `:today` 而 Rust 正式契约要求 `:regular` 的种子后缀；普通批次与额外批次现在统一使用 proposal v2，避免特定学习日无法打开或两端选词不一致。

### Performance

- Android 书库改用按内容哈希寻址的 JPEG 缩略图（最长边界 384×512、质量 82、共享 64 MiB 可再生磁盘上限），屏外封面延迟解码；首屏先挂载 6 张卡片，80 ms 后补齐其余卡片。移除一级导航与底部操作的高成本模糊，并保留卡片布局隔离。
- 词典资源状态、集合和学习 dashboard 增加 30 秒短时缓存与并发请求去重，所有写操作精确失效；学习计划列表把逐计划来源/统计 N+1 查询改为固定批量查询。系统 Back 监听器和滚动快照也不再随每次路由渲染重复注册。
- Huawei OCE-AL50 / Android 12（API 31）的 alpha.6 ARM64 debug 包在 14 本真实刊物上：常见冷启动 `am start -W` 为 0.5–0.7 秒；稳定书库约 176 MiB PSS / 45 MiB Graphics，连续页面切换后的高水位约 279 / 138 MiB（旧全尺寸封面实现约 391 / 246 MiB）；书库切回两帧内先显示 6 本需 55–85 ms，约 130 ms 补齐 14 本。自动往返滚动 260 帧的新口径卡顿为 1 帧（0.38%，P90 15 ms；legacy 2.31%）。
- Windows 打包只保留 `zh-CN` / `en-US` Electron locale，并排除 source map、测试和无关构建输入；NSIS 从 alpha.5 的 107,831,264 bytes 降至 99,109,235 bytes。最终隔离资源 smoke 的冷启动私有提交为 233.41 MiB、普通文章 303.36 MiB、词典活跃 325.84 MiB，30 秒闲置 CPU 0.02%，所有既定阈值通过。

### Changed

- 删除生产路径中的旧 queue proposal v1、`prepare/open today` 旧入口、未使用的移动契约版本字段和空 `MobileSyncClient` 转发层；FSRS review v1 仅保留为内部归一化/算法兼容向量。额外批次补齐 proposal v2 的 seed、完整 planning input、fingerprint 和服务端复核。
- 收敛 26 条既有 TypeScript lint warning，替换学习统计八元组、缩略图 `Result<_, ()>` 和过大的 EPUB 导入枚举等 Rust 可维护性问题；TypeScript、Rust `clippy -D warnings` 与静态依赖边界均为零警告/零违规。
- Android release 构建固定 ARM64 与 R8，缺少仓库外稳定签名时直接失败；正式 Logo、Windows Authenticode、稳定 Android keystore 与非 debug APK 仍作为 `v1.0.0` 发布候选门禁，不进入本次 Alpha。

### Verification

- `pnpm typecheck`、`pnpm lint`、`pnpm audit:prod`、`pnpm test`、`pnpm test:interop`、源码/打包 Electron 协议冒烟、Rust `fmt` / 零警告 `clippy` / `cargo test --all-targets`、Kotlin `:fpr-platform-plugin:testDebugUnitTest`、`pnpm perf:smoke`、`pnpm dist` 与 Android ARM64 debug 构建均通过。最终全量计数为 43 个 TypeScript 测试文件通过、1 个跳过；212 项通过、3 项跳过；Rust 75 项通过、1 项按设计忽略。
- Windows x64 NSIS `ForeignPressReader-1.0.0-alpha.6-Setup.exe` 为 99,109,235 bytes，SHA-256 `80DFECA4DD6B72F0B27DE412D57AE0FBFF89B7DE9DD82EDE2FEF696D4F08DDD5`，按 Alpha 计划未做 Authenticode。Android ARM64 debug APK 为 248,742,244 bytes，SHA-256 `D2541F510C3C53DB49849F69929DD88D12A71D2B78479ADFB6416B8B9DCA37F8`；核对为 `com.local.foreignpressreader.dev`、`versionName=1.0.0-alpha.6`、`versionCode=1000005`、仅 `arm64-v8a`，并通过 APK v2 debug 签名验证及同包覆盖安装，用户数据库和 14 本刊物保持原样。

## 1.0.0-alpha.5 - 2026-07-19

### Fixed

- Android 联网安装 ECDICT 时，应用级任务条现在持续显示原始 CSV 与词形表的已下载字节、当前下载阶段及随后数分钟的索引构建阶段；安装仍可取消，也不会阻止离开设置页。此前真实设备上的 65.9 MB 原始 CSV、2.3 MB 词形表与约 24 MB 标准 SQLite 构建均在后台正常推进，但只有不定进度条，容易被误认为设置界面卡死。
- 书库按“导入时间”排序现在使用刊物首次进入任一端外刊阅读器的时间。刊物包恢复会保留源端时间；相同刊物已独立存在于两端时，生命周期合并取两端较早时间，且无需重复传输刊物内容。

### Changed

- 刊物内容包升级为 format v2，并要求清单携带 `firstImportedAt`。按当前测试阶段策略移除 format v1 读取与兼容向量；旧 `.fprpub` 会被明确拒绝。数据库 migration、便携备份 format v2、Sync Model v2 与内容 ID v2 均未改变。

### Tests

- 增加 Android Tauri 词典安装事件订阅测试、刊物包 v2 跨 TypeScript/Rust 向量与 v1 拒绝测试，以及“传包恢复原始时间”和“双方已有相同刊物时取更早时间”的同步回归测试。

### Verification

- `pnpm typecheck`、`pnpm lint`、`pnpm test`（40 个测试文件通过、1 个跳过；201 项通过、3 项跳过）、Rust `fmt` / 零警告 `clippy` / `cargo test`（72 项通过、1 项按设计忽略）及 Kotlin `:fpr-platform-plugin:testDebugUnitTest` 均通过；lint 仅保留 27 条既有 warning，无 error。
- 已生成 Windows x64 NSIS 安装包 `ForeignPressReader-1.0.0-alpha.5-Setup.exe`（107,831,264 bytes，SHA-256 `30B7C42D18E256F861817F4A993BF6C1C53F5671A7B7D8A744C63BA1FAD2C13D`）与 Android ARM64 debug APK（238,492,628 bytes，SHA-256 `AE6703288FF5FAD6203AF639EE9242660BBC200D738EF6093FBB9B469B0F1884`）。APK 核对为 `com.local.foreignpressreader.dev`、`versionName=1.0.0-alpha.5`、`versionCode=1000004`、仅含 `arm64-v8a`，并通过 APK v2 签名验证。
- 新 APK 与手机既有 alpha.4 的签名证书一致，已在已授权的 ARM64 测试设备上覆盖安装成功；随后按用户明确要求执行 `pm clear com.local.foreignpressreader.dev`，原手机应用数据已不可恢复地清空。复核数据目录仅 4 KiB、应用未运行，并再次核对安装版本为 alpha.5/1000004；未启动应用或替用户执行功能验收。

## 1.0.0-alpha.4 - 2026-07-19

### Fixed

- 修复首次 Windows → Android 大批次同步在刊物包传完后必然回滚的问题：Android 提交事务曾向正式 `sync_peer_state` 表写入不存在的 `updated_at` 列，现改为 migration 1 定义的 `last_sync_at`。该错误此前被笼统映射成“无法访问应用私有存储”；现在同类事务写入失败会明确说明已安全回滚且本地数据未改变。
- `/commit` 的接收端应用阶段允许等待至 30 分钟；Windows 上传 NDJSON 后也会给接收端足够时间解析、生成预览，不再分别被 30 秒控制请求超时或 10 秒响应头超时提前中断。普通控制请求与刊物包收尾仍保持较短超时。
- 成功或失败应用刊物包后都会清理本批次的临时 `sync-restore` 目录，避免留下空批次目录。

### Verification

- `pnpm typecheck`、`pnpm lint`、`pnpm test`（39 个测试文件通过、1 个跳过；199 项通过、3 项跳过）、Rust `fmt` / 零警告 `clippy` / `cargo test`（72 项通过、1 项按设计忽略）及 Kotlin `:fpr-platform-plugin:testDebugUnitTest` 均通过；lint 仅保留 27 条既有 warning，无 error。
- 已生成 Windows x64 NSIS 安装包 `ForeignPressReader-1.0.0-alpha.4-Setup.exe` 与 Android ARM64 debug APK；APK 本地核对为 `com.local.foreignpressreader.dev`、`versionName=1.0.0-alpha.4`、`versionCode=1000003`、仅含 `arm64-v8a`，并通过 APK v2 签名验证。按用户要求未连接或覆盖安装手机、未启动应用、未执行真实同步，修复后的双设备重试仍留待人工验收。

### Tests

- 增加基于正式 migration 建库的 Android 同步提交回归，覆盖回执、`last_sync_at`、inbound revision 与重复 commit 幂等；增加各同步阶段响应超时策略测试。真实双设备重试仍由用户手动执行。

## 1.0.0-alpha.3 - 2026-07-19

### Verification

- Wire v2 重构门禁全部通过：`pnpm typecheck`、`pnpm lint`、`pnpm test`（39 个测试文件通过、1 个跳过；199 项通过、3 项跳过）、Rust `fmt` / 零警告 `clippy` / `cargo test`（71 项通过、1 项按设计忽略）及 Kotlin `:fpr-platform-plugin:testDebugUnitTest`。
- 已生成 Windows x64 NSIS 安装包 `ForeignPressReader-1.0.0-alpha.3-Setup.exe` 和 Android ARM64 debug APK；APK 与手机现有开发包签名一致，并已通过 ADB 覆盖安装到已授权的 ARM64 测试设备，核对为 `versionName=1.0.0-alpha.3`、`versionCode=1000002`。未启动应用，双方发现、真实数据同步与断线恢复仍留待人工验收。

### Fixed

- 将单一路径 DNS-SD/NSD 发现重构为 Wire v2 主动发现：Windows 与 Android 同时使用 UDP 组播、各 IPv4 网卡定向广播、立即单播回应和并发 `/24` 扫描；HTTPS 公开身份探针核对 TLS 证书指纹，15 秒验证窗口与 30 秒候选保留避免单次丢包造成设备闪烁。
- 将整批 `/prepare` JSON 改为小型描述加 NDJSON 流式批次，解除真实书库超过 8 MiB 时的请求上限；批次与刊物包按长度、数量和 SHA-256 原子暂存，断线后复用 30 分钟内已完成载荷，重复 prepare/commit 由回执幂等恢复。
- 修复 Windows/Electron 文件快速路径把已关闭 ZIP 的条目交给新归档流读取，导致压缩 EPUB 的解析 worker 正常退出但没有返回结果、界面长期停留在“正在解析”的问题。Windows 现在按中央目录定位本地数据范围、分块 Deflate 解压并逐条校验大小与 CRC；原始 EPUB 仍只是一次性外部输入，不会复制进应用数据目录。

### Reliability

- Windows 与 Android 的 LAN Blob 传输统一为 10 秒建连/响应头、30 秒 JSON、60 秒无进展和 30 分钟总期限；慢速但持续有进展的传输不再被整请求 30 秒期限误杀。取消、超时和断连会销毁请求/源流、清理监听器与 `.part`，且不会提交数据库记录或不完整刊物。
- Windows 与 Rust 的便携 format v2 导入/导出改为逐记录、逐文件流式处理；完整校验后才在单一数据库事务中合并，失败时回滚数据库并补偿清理本次创建的刊物目录。Windows 导出使用同目录临时文件、同步落盘和原子替换，替换失败保留旧备份。
- EPUB worker 在正常退出但未返回消息时会明确失败并释放 worker/流；Windows 先做 ZIP 中央目录预检，文件路径按条目分块读取并逐条校验 CRC，Android 补齐规范化重复路径与压缩比检查，两端统一空间、大小、CRC、穿越和取消清理行为。

### Security

- EPUB 安全策略在双端固定为 500 MiB 原文件、4,000 条目、1 GiB 展开量、16 MiB 文本、64 MiB 单图、750 MiB 引用图片、2,000 压缩比，并只接受 JPG/JPEG、PNG、GIF 与 WebP；SVG/非栅格资源明确拒绝。
- Electron 生产 renderer 改从 `fpr-app://bundle/index.html` 加载。协议只提供打包 renderer allowlist；精确拒绝路径穿越、未知文件、远程/`file://` 页面、任意导航、弹窗、WebView 和未授权权限。
- 所有 IPC 统一验证当前主窗口、主 frame 与精确入口 URL；开发服务器校验不再使用字符串前缀。Kotlin 网络 URL、私有路径、错误映射与取消状态提取为 JVM 可测策略，API 密钥仍不进入日志、错误、IPC 或备份。
- `yauzl` 固定升级至 3.2.1；CI 增加 TypeScript/Rust 生产依赖审计与 core/main/renderer 静态依赖边界检查。

### Compatibility

- 保持 `formal-v1` migration 1、便携 format v1/v2、Sync Model v2、身份存储格式与内容 ID v2 的既有语义不变，未新增数据库迁移；测试阶段的 LAN Wire v1 已整体替换为 Wire v2，不提供旧端点。
- format v2 接受合法 RFC 3339 时区表示；冲突比较使用解析后的时间点与 device ID，新写时间统一为 UTC 毫秒 `Z`。备份仍严格校验正式数据集顺序、哈希、字节数、记录数、内容 ID 与当前 schema。
- 增加不含用户数据的 format v2 双运行时逻辑向量和仅测试构建可用的 Rust interop 工具，验证 Windows → Rust 与 Rust → Windows、微型刊物包、墓碑/reset、时间冲突和重复导入；工具不进入 Android 安装包。

### Tests

- CI 拆分为并行 TypeScript、Rust、Android JVM 与便携 interop 门禁；覆盖 typecheck、ESLint、依赖边界、生产构建、审计、Rust fmt/Clippy/全目标测试、JDK 17 Kotlin 编译和 JVM 单元测试。
- 增加 LAN 可注入期限向量、EPUB bomb/条目/路径/格式/worker 生命周期、便携损坏回滚/原子替换、Electron 协议与 IPC 信任边界测试，以及打包后自定义协议启动冒烟。
- 增加注入 mock client 的移动组件行为测试，覆盖词典 latest-wins、无资源快照与语境、学习两阶段状态、备份预览/确认/取消/错误和同步进度/取消/重试；删除对应的脆弱源码字符串断言，并移除未引用的重复词典页面实现。
- 增加发布前人工验证清单，明确真实 Android instrumentation、双设备互传、至少 500 MiB 限速/取消/重试/后台恢复与双向 SAF 备份不作为每个 PR 的模拟器门禁。

### Changed

- 刊物持久化改为 parsed-only：Windows 与 Android 导入只保存规范化目录、正文块和实际资源，不再复制用户选择的原始 EPUB；schema migration 2 为既有记录增加 `source_storage`，启动时仅在文章/栏目、引用资源、受管路径与源哈希均验证通过后删除旧 `library/<publicationId>/source.epub`，外部原文件始终不动。
- 正式便携备份升级为 format v2；活动刊物使用跨平台 `.fprpub` 内容包携带规范化 `publication.json` 与资源，导出和导入均不包含原始 EPUB，当前版本明确拒绝 format v1 及 Demo/其他旧格式。
- 新发送批次升级为 Sync Model v2，以 `publication-package` 传输规范化刊物内容并以原 EPUB 内容哈希维持稳定身份；Sync Model v1 保持冻结，仅在内部接收映射层可一次性解析旧 source blob，解析后不会留存源文件。
- Windows 应用自有语音/词典缓存迁移到大小写不冲突的 `app-cache`；公网请求和双端阅读资源响应改为 `no-store`。桌面存储报告拆分网络响应、代码、GPU/图形与浏览器临时对象，Android 安全清理同时清除 WebView 缓存。
- 原“跨设备同步”占位升级为 Windows/Android 前台局域网定向同步：双方进入页面后以 Wire v2 主动广播和扫描发现，DNS-SD/Android NSD 仅作兜底；使用固定证书的 HTTPS、六位码双端确认和持久信任。发送端按 Sync Model v2 生成分页摘要和 NDJSON 快照/增量批次，只发送接收端缺少的 `.fprpub` 解析内容包，接收端预览后显式接受并原子应用。应用中阶段不可取消，重复批次按回执幂等。
- 同步页离开或 Android Activity 停止时关闭发现与监听；Android 通过 Keystore 保存身份并按需申请附近 Wi-Fi 设备权限，Windows 使用主进程安全存储。两端都不通过同步发送原始 EPUB、SQLite、缓存、词典资源、API 密钥或证书私钥。
- 阶段 G 已通过 TypeScript 类型检查、同步单元测试、Rust 主机编译/协议向量、Kotlin 编译、Windows x64 NSIS 与 Android ARM64 debug APK 构建；按当前计划尚未执行真实 Windows ↔ Android 设备互传的端到端矩阵。

### Added

- 增加 formal schema v2、刊物内容包与 Sync Model v2 兼容向量，以及双端源文件升级清理、无源便携往返、跨平台刊物包和失败保护测试。
- 增加局域网 Wire v2 跨 TypeScript/Rust 兼容向量，固定端口、组播地址、限额、发现报文、配对码、对称信任令牌与 NDJSON 载荷哈希；接收预览按本机实际逻辑状态和缺失内容包计算，并在确认前拒绝同 ID 不可变记录冲突。

- 增加版本化 `MobilePlatformServices v1`：Android 设置可通过 SAF 导出/选择正式便携 format v2，Rust 校验哈希、条目/展开限制、正式 schema 与内容 ID 后预览并按 `NewerWins` 合并；导入 EPUB 继续复用共享 TypeScript 解析，活动队列、密钥、日志与可再生缓存不进入备份。
- 增加 Android 四类存储报告（应用程序、资源、用户数据、缓存）、重新扫描、安全缓存清理、需独立确认的 AI 文本缓存清理、系统应用存储页入口，以及后续由阶段 G 升级为真实能力的跨设备同步设置入口。
- 增加与 Windows 对齐的隐藏“开发与调试”：五秒内连续点击设置标题十次后仅本次运行显示；开发模式、脱敏日志、模拟下一学习日、全量学习重置和恢复出厂均由独立状态与确认词门控。
- 增加 Android Alpha 稳定 release 签名配置和仓库外示例；正式身份固定为 `com.local.foreignpressreader`，永久 debug 身份使用 `.dev`，缺少稳定签名时 release 构建直接失败。
- 增加版本化 `MobileOnlineServices v1` 逻辑契约与窄 Tauri 客户端，接通 Android DeepSeek/OpenAI/Kimi 设置、Keystore 密钥状态、保存替换/删除、连接测试、文章分批翻译、进度、取消和精确供应商/模型缓存。
- 增加 Android 百度词典原子双密钥、Access Token 内存使用、30 天/64 MiB 查询缓存、本地失败回退、当前翻译服务例句翻译，以及不要求已有词条或先选词性的 AI 文中义。
- 增加 Android 系统 TTS、Google Standard 与 MiniMax 中国站语音：单词/文章独立供应商、地区/模型/音色/语速、设置试听、词典/学习发音、从可见段落连续朗读、段落跳转、暂停继续、audio focus 与 256 MiB LRU 缓存。
- 增加 Android 数据与存储、可再生安全缓存/AI 缓存清理、脱敏诊断日志开关/分享/清理、受限 FileProvider、隐藏开发入口、计划删除/可选逐词重置、全量学习重置、模拟学习日和恢复出厂。
- 增加版本化 `MobileDictionaryCenterClient v1` 与 `MobileStudyManagementClient v1`；renderer 复用既有 `DictionaryApi`、`VocabularyApi`、`StudyApi` DTO，不复制 Android 专用领域模型。
- 增加共享纯 TypeScript 词条 presentation builder，统一标签去重、词性分组、长释义折叠、词形、例句和用户快照降级；Windows 词典与移动全页词条已接入，阅读/学习移动深链复用该详情；桌面阅读器抽屉保持既有展示，不作为 Android Alpha 阶段门禁。
- 增加 Android E2 词典中心：词典检索/我的生词独立状态、180 ms 防抖与 latest-wins、考试词集、高级筛选/排序/分页、手机全页词条、收藏语境和原文章深链。
- 增加 Android standard-v1/full-extension-v1 独立词典资源管理、空间预检、安装、修复、降级、删除与取消；完整扩展必须匹配基础包的 dataset revision 和 `lexemeMapHash`。
- 增加 Android E3 学习中心：今日 dashboard、长期计划与来源、new/review/carryover、两阶段回答与改判、强化、太简单与 6 秒撤销、额外批次、历史筛选、计划词表、D/S/R 和逐词排除/暂停。
- 增加纯 TypeScript study proposal/envelope v2，覆盖跨计划去重、配额选词、三种队列顺序、carryover/deferred-new、额外批次、canonical FSRS 参数和强化插入；Rust 继续接受 v1 并验证 v2 后事务提交。
- 增加 Android 每日学习设置：混合/复习优先/新词优先、cutoff、目标记忆率、最长间隔、保存与撤销，并明确只对下一批任务生效。
- 增加 Android Alpha 移动壳快照 v1 和带 `hostTab` 的词条深链；计划详情与安全筛选可恢复，活动答题 session 与隐藏开发页不持久化。
- 增加 Tauri 2 Android 外壳、标准 Gradle 工程和独立正式移动入口；固定 `@tauri-apps/cli 2.11.4` 与 `@tauri-apps/api 2.11.1`。
- 增加内部 Rust `rusqlite` repository，在事务中重放不可改写的 `formal-v1` migration 1 语义；启用 WAL、外键、完整性检查、旧 generation/未知高版本拒绝与失败回滚。
- 增加应用私有 data/cache/log/staging 目录、同目录原子替换和默认关闭的 JSON Lines 脱敏诊断日志。
- 增加无 guest 直接权限的 Kotlin 平台插件：Android Keystore AES-256-GCM 凭据存储、固定 HTTPS 请求、系统代理/VPN、超时、取消、离线错误和 debug 应用数据清除。
- 增加 `formal-v1` 跨 TypeScript/Rust 兼容向量，固定 schema 指纹、稳定 ID 与版本排序语义。
- 增加 Android EPUB 本地阅读纵向切片：系统文件选择器、私有 staging、Rust ZIP/CRC/空间校验、SHA-256 去重、事务入库、受控图片协议和失败清理。
- 增加窄 `MobileReadingClient`、解析 Web Worker，以及独立移动书库、目录、正文阅读、外观设置、系统返回键和稳定锚点恢复界面。
- 增加 `epub-content-v2` 跨 TypeScript/Rust 向量，固定同一规范化计划的刊物、栏目、文章、内容块 ID 与顺序。
- 增加正式移动词典、词汇与学习管理契约、移动学习错误分类和数据分类，固定逻辑 DTO、取消、幂等命令及版本边界。
- 增加 D0 学习兼容向量，由 TypeScript 与 Rust 共同验证 `LexemeKey`、词形候选、FSRS transition proposal、scheduler profile 和队列摘要。
- 增加可重复生成的小型 `.fprdict` SQLite 测试包、版本化 manifest、私有 staging 校验、空间预检、只读完整性检查及旧包保留的原子替换探针；真实 ECDICT 不进入仓库。
- 增加 Android D2 生词与语境纵向切片：正式用户词汇/来源/语境事务、revision、墓碑、快照列表、阅读器收藏状态，以及跨 TypeScript/Rust 的稳定身份向量。
- 增加 Android D3 最小学习闭环：以“我的生词”为来源的计划、今日队列、两阶段单卡回答、FSRS 卡/不可变事件原子提交、命令幂等、版本冲突和跨日恢复。
- 增加 Android E0 正式产品壳：四项底部导航、宽屏 navigation rail、独立 tab 栈、沉浸式阅读/答题、集中 Back 语义和版本化安全 UI 快照。
- 增加移动公共组件与语义设计令牌，覆盖 app bar、按钮、卡片、搜索、分段控件、sheet/dialog、任务条、空/错/离线、snackbar、词条和答题组件。
- 增加 Android E1 书库文件管理：扁平分类、稳定排序、网格/列表、单本重命名/归类/删除，以及显式或长按进入的独立选择模式、全选、批量归类和批量删除。
- 增加移动设置六分区框架与类型安全子路由；阅读外观提供 Windows 对齐的动态预览、主题、15–30 px 正文字号、1.4–2.2 行距、纸张暖度和 640/760/900 px 语义版心，其他分区只展示真实能力边界。

### Changed

- 完成 Android 阶段 F 的代码收尾：`1.0.0-alpha.2` 成为 Android 后续数据演进的支持起点；正式 migration、便携备份、Sync Model 与内容 ID 基线继续保持不可改写。
- 完成 API 35 x86_64 与 Huawei API 31/ARM64 的精简集中 Alpha 验收：双 ABI 安装、同签名覆盖、离线冷启动、数据库/WAL/SHM 保留、SAF 备份往返、四类存储、分级缓存、十击开发入口、诊断分享、字体/横屏和恢复出厂通过，阶段 E2–E5 与 F 关闭。
- Android 手机视觉密度再次收敛：正文 UI 基线降为 13 px 等效字号，按钮/卡片/分段控件缩小并统一圆角，手机书库改为三列封面，底栏降为约 60 dp；深色主按钮移除红色发光阴影，封面更多操作改为紧凑圆形浮层。
- Android 设置根页取消“阅读与语言/学习与本机”二次分组；词典资源安装、升级、修复、降级和删除统一移入“词典服务”，仅选择“百度增强”时展开失败回退、例句翻译与双密钥配置。
- Android 计划详情对齐 Windows 的标题文案、来源/配额摘要、熟练度环图与图例、编辑/暂停/归档动作和常驻状态筛选；阅读器移除逐段“朗读本段”和缓存状态大卡片，全文译文改由单一工具栏入口管理，段落译文只保留紧凑展开按钮。
- Android 受控刊物资源 CSP 补充固定 `reader-asset.localhost` 图片来源，修复 Huawei WebView 114 下封面与正文图片被错误拦截的问题；加载失败时显示稳定刊名字首占位。
- Kimi 8K 翻译使用收紧后的输入/输出预算，并在 `finish_reason=length` 或超限时自适应拆分；Windows 与 Android 的翻译缓存均绑定实际选择的供应商和模型，不回退到同供应商任意最新模型。
- Windows 阅读器“分析文中义”取消已有词条/词性前置门控，允许只基于点击词形与原句生成结果；上下文定义记录实际解析依据，百度例句翻译与双密钥保存、失败回滚、删除改为单次原子更新。
- Android 设置从 E1 能力占位升级为真实翻译、词典、语音、学习、数据/存储和会话级隐藏开发控制；便携备份已接入正式导入/导出。
- Android 词典普通导航、搜索和点词改用快速 manifest/file generation 状态与可失效只读运行时缓存，不再执行 `quick_check` 或全词元哈希；深度校验仅用于显式修复、安装发布前或 generation 变化后的后台检查。
- 安装、修复、降级和删除词典资源后原子失效运行时 generation；新资源验证成功前保留旧有效资源，查询失败才报告损坏。
- Android 将词典、学习和对应设置从移动壳单文件拆为独立功能模块；壳层只管理路由、全局任务与共享深链。
- 硬删除计划、全量学习重置和模拟学习日已作为 E4 开发者能力接通并由 Rust 强制门控；普通移动计划管理仍只提供启用、暂停与归档。
- Android D1 增加固定 ECDICT revision 的联网预载与预构建包安装：原生流式下载校验精确大小/Git blob SHA，Rust 在私有 staging 生成并原子发布 standard-v1；真实源文件和生成数据库不进入仓库。
- 增加 Android 英文词元/词形与中文简释搜索、词条详情，以及阶段 C 阅读器分词、点击查词、词形候选、上下文和 Android Back 薄面板。
- 增加独立只读 Rust 词典仓储与查询取消；普通搜索/查词不附加或写入 `reader.sqlite`，renderer 不获得私有路径、URL、SQL 或原生插件访问权。

- D1 将最小英中搜索作为用户确认的受控范围扩展；考试词集、高级筛选、百度增强、完整定义、收藏/语境、计划和 FSRS 仍保持后置。
- Rust `lemma.en.txt` 解析收紧为与 Windows 相同的 `lemma/数字 -> forms` 规则；完整固定源对照统一为 59,119 个稳定词元、59,137 条标准词条、67,810 个词形和相同 `lexemeMapHash`。
- 移动书库增加“我的生词”和“今日复习”入口；词典面板可收藏词条/语境并在不卸载文章的情况下打开生词列表，复习页保持 D1 视觉语言并只覆盖最小计划与单卡流程。
- D3 保持共享 TypeScript 为队列与 FSRS 唯一计算实现；Rust 校验 D0 proposal、`commandId` 与 `expectedVersion` 后，在一个事务中提交卡片、事件和 session item。
- Android 将 D 阶段书库首页快捷按钮和全屏 overlay 重构为“书库、词典、背单词、设置”正式模块；“我的生词”归入词典，阅读器与学习页可在保留原 tab 栈的前提下直达。
- 移动浅深主题统一采用 Windows 暖纸、墨色和编辑红语义令牌；横屏手机保持底部导航，足够宽高的折叠屏/平板改用 80 dp navigation rail。
- Android 书库移除非 Windows 基线的主页搜索和刊物目录搜索；保留阅读器“当前文章查找”。选择态改用封面外侧红色双层边框或列表整行红框，不显示 checkbox。
- Android 正式壳使用 13 px 等效 UI 正文和紧凑字号/间距/圆角，手机使用 14 px 页面留白、约 60 px 安全区底栏和三列书封；600 dp 四列、840 dp 五列并切换 navigation rail，主要触摸目标保持 40–48 dp。
- 刊物卡片补齐文章/栏目数、分类和导入日期；刊物目录按移动端方式折叠栏目，当前文章搜索、缓存译文、稳定锚点和受控资源协议保持不变。

- Vite 同时构建 Electron 与 Tauri 页面；Android dev 模式只在 `TAURI_DEV_HOST` 下把根入口映射到正式移动页面，Electron 入口保持不变。
- Android 静态构建使用独立 release 配置加载本地 `tauri.html`，开发命令固定通过 ADB reverse 使用 127.0.0.1。
- Android manifest 禁用系统应用数据备份；renderer capabilities 保持 `core:default`，不开放 SQL、文件系统、HTTP、日志或安全存储插件权限。
- EPUB 解析采用 Kotlin/Rust/Web Worker 混合流式边界，避免把完整 EPUB 复制进 WebView；Electron 继续使用现有 JSZip 文件快速路径，两端复用同一纯 TypeScript 规范化规则。
- D0 选定“共享 TypeScript 计算 + Rust 校验并原子提交”作为 FSRS/队列边界，避免为 Android/iOS 复制第二套调度算法；正式提交留到 D3。

### Removed

- 删除预正式 Prototype/Stage A-B 诊断入口、D0 WebView/词典探针、E0/E1 视觉 fixture 与捕获脚本、旧 `TauriAppClient`、重复维护客户端和旧最小学习命令面；正式 Tauri 入口只渲染 Android 产品应用。
- 删除旧移动壳 key/version 映射；Android Alpha 使用新的 `fpr.android.alpha.shell.v1`，不读取、迁移或删除旧 Demo 与预正式会话状态。

### Security

- Android 在线服务只允许固定 HTTPS allowlist、受限方法/大小/超时和统一错误分类；renderer 不获得任意 URL、私有路径、SQL、文件系统或原生插件能力。翻译、百度和语音密钥只由 Keystore 原生层读取，IPC/错误/日志/测试快照不返回原值。
- Android CSP 不开放公网 `connect-src`，诊断分享只暴露私有 `diagnostics/` 子目录；缓存清理、日志清理和恢复出厂均限制在应用受管路径，不读取、迁移或删除旧 Demo 数据。
- E2/E3 没有改写 `formal-v1` migration 1、便携备份 format v1、Sync Model v1 或内容 ID v2；full-extension-v1 作为可再生本地资源，不进入便携备份或同步。
- ECDICT 联网预载只允许固定 commit 的官方 raw URL 和两项固定镜像，双重校验 URL、字节数与 Git blob SHA；取消、内容漂移和下载失败均清理私有 staging，不发布半成品。

- EPUB 按 500 MiB 原始文件、4,000 条目、1 GiB 展开量、单文本/图片和总图片上限校验，拒绝重复、越界和非栅格资源路径；renderer 不能读取任意 ZIP 入口或私有文件。
- 导入取消、解析失败、事务失败和应用重启会清理私有半成品；启动时只删除符合受管刊物 ID 且数据库无对应记录的孤儿目录，不触碰非受管目录。
- 词典包只接受固定的 `manifest.json` 与 `ecdict-base.sqlite`，校验 SHA-256、schema/profile、条目计数和 `lexemeMapHash` 后才发布；失败或取消不会替换现有资源。

### Documentation

- 记录阶段 F 的便携备份/存储/开发边界、十击解锁、正式/调试身份、稳定签名、旧路径清理、自动化证据与集中设备结果；稳定签名 release 和扩展无障碍/音频附件矩阵转为发布候选任务，不回开阶段 F。
- 记录阶段 E4 的在线/系统服务边界、设置与阅读器交互、真实供应商脱敏冒烟、API 35 系统 TTS、双 ABI 与 Windows 分发门禁；结合阶段 F 精简集中批次关闭 E2–E5 的 Alpha 设备门禁。
- 记录阶段 E2/E3 的共享契约、快速/深度词典校验边界、standard/full 资源、proposal v1/v2 兼容、移动 UI 与 E4 在线服务槽位；自动化、既有设备证据与阶段 F 双设备集中抽查共同完成阶段收口。
- 记录阶段 D1 的供应链边界、完整源 Windows/Rust 对照、API 35 全量预载/搜索/真实 EPUB 验收，以及纳入阶段 D 集中清单的华为 API 31 修正版待测项目；下一阶段仍为独立 D2。
- Android 开发改为“自动测试与 API 35 模拟器贯穿子阶段、华为 API 31 在每个大阶段末集中验收”；D1 修正版真机项并入阶段 D 清单，不再阻塞 D2/D3 开发。
- 明确 Windows/Android 对齐产品术语、数据语义、信息层级、状态反馈和核心视觉令牌，但保留桌面导航与移动触摸/返回键/安全区的合理平台差异；D2/D3 延续移动薄 UI，E0–E5 再系统完成四大模块设计与功能覆盖对照。
- 记录 D2/D3 的自动测试、双 ABI 构建、API 35 真实文章收藏/计划/单卡/冷启动闭环和数据库审计，以及华为 API 31 的 D1 搜索/100 次点词、D2 快照、D3 中断/双击/强化、覆盖安装、字体/横屏、内存与日志核心真机批次；阶段 D 核心退出条件通过。

- 建立 Tauri Android 主迁移路线，明确 Electron Windows 保持对照端，Android 按真机外壳、平台基础、阅读、学习、移动 UI、Beta、同步的顺序推进；局域网同步不再作为首个 Android 原型的完成条件。
- 将正式 Git 根目录迁至纯英文路径，建立单仓库多平台目录、分支、依赖和测试规范。
- 记录阶段 A 的华为 API 31 真机、API 35 模拟器、MSVC/Gradle 前置环境和 Tauri dev 代理行为。
- 记录阶段 B 的 SQLite、Keystore、网络错误分类、系统代理、恢复出厂、16 KiB ELF 对齐和双 ABI 真机/模拟器验收；明确阶段 C 才开始 EPUB 本地阅读闭环。
- 记录阶段 C 的混合导入边界、资源安全模型、真实 Economist 样本、华为 API 31 与 API 35 模拟器冷启动验收；阶段 D 才开始词典、生词和 FSRS。
- 将原阶段 D 拆分为 D0 契约/算法/资源 spike、D1 离线 ECDICT、D2 生词与语境、D3 最小计划与 FSRS 单卡；增加逐阶段交付、停止条件、风险登记、分支/提交顺序及 TypeScript/Rust/真机测试矩阵。
- 将移动功能覆盖细化为 E0 产品壳、E1 书库阅读、E2 词典生词、E3 背单词、E4 设置与在线服务、E5 收口审计；便携备份和 Beta 加固仍为 F0–F1，局域网同步仍保持阶段 G。
- 对照 Windows Electron 实际 `AppClient`、四大模块、阅读器和界面截图建立阶段 E 详细计划：手机四项底部导航、宽屏 navigation rail、独立 tab 栈、正式设计系统、桌面交互的平台化映射、逐模块功能账本和真机/截图矩阵。
- 完成阶段 E 功能对照账本和 E0 验证记录；每项 Windows 能力均已分配 Android 表达、owner、阶段、状态和验收编号，下一阶段进入 E1。
- 完成阶段 E1 验证记录并更新功能账本；E1 本地书库和阅读项均关闭，设置服务入口明确保留 E3/E4/F0 边界，下一阶段进入 E2。
- 明确 E0/E1 完成后可并行推进 E2 词典/我的生词与 E3 背单词，共享词条详情、深链和客户端扩展先冻结共同接口。
- 记录 D0 架构决策、双设备资源/WebView 验收、正式契约无变化审计，并将下一主线收敛为单独规划 D1。

### Build

- 增加 pnpm 11 workspace 安全配置，显式审核 Electron 构建链允许执行安装脚本的依赖，保证移动或全新克隆后可按锁文件重建依赖。
- 增加 ARM64/x86_64 Android debug APK 构建，并保留现有 Electron 类型检查、测试与 NSIS 打包流程。

### Tests

- 阶段 E4 本机回归：`pnpm typecheck` 通过；全量 `pnpm test` 为 35 个测试文件、174 项通过、2 项跳过；Rust 为 65 项通过、1 项仓库外 ECDICT 源测试按设计忽略，`cargo fmt --check` 与零警告 Clippy 通过；Kotlin 编译、ARM64/x86_64 split debug APK、API 35 x86_64 覆盖安装/冷启动/设置与系统 TTS 试听、Windows x64 NSIS 和 `git diff --check` 通过。
- 使用外置且未落盘到仓库/日志的测试凭据按产品请求格式完成 Kimi Moonshot V1 8K、DeepSeek V4 Flash、OpenAI GPT-5.4 nano、Google TTS、MiniMax TTS 与百度词典真实冒烟；所有服务返回有效 JSON、音频或词典数据，未输出或持久化密钥。
- 阶段 E2/E3 本机回归：`pnpm typecheck` 通过；全量 `pnpm test` 为 34 个测试文件、165 项通过、2 项跳过，移动 E2/E3 定向 Vitest 为 6 个文件、36 项通过；Rust `--all-targets` 为 54 项通过、1 项仓库外 ECDICT 源测试按设计忽略、0 失败，`cargo fmt --check` 与零警告 Clippy 通过；ARM64/x86_64 Android split debug APK 和 Windows x64 NSIS 构建通过。API 35 与华为 API 31 的本轮性能/视觉证据尚未验证，因此 E2/E3 尚未标记为阶段完成。
- 阶段 E1 最终回归：30 个 TypeScript 测试文件共 140 项通过、2 项跳过；43 项 Rust 测试通过、1 项仓库外 ECDICT 源测试按设计忽略；Rust 格式/Clippy、ARM64/x86_64 Android debug APK、Windows NSIS 和 `git diff --check` 通过。84 张 fixture 截图的横向溢出和关键触摸目标审计为零失败；API 35 完成书库选择/Back/冷启动、设置、浅深主题、横屏与系统字体 1.5 验收。
- 阶段 E0 最终回归：27 个 TypeScript 测试文件共 125 项通过、2 项跳过；41 项 Rust 测试通过、1 项完整外部 ECDICT 源测试按设计忽略；`cargo fmt --check`、零警告 Clippy、ARM64/x86_64 Android debug 构建与 `git diff --check` 通过。确定性 fixture 共审查 28 张浅深主题、多尺寸、横屏与字体缩放截图；API 35 验证四模块、手势安全区、冷启动 tab 恢复、窄横屏底栏和根页 Back 交还系统。

- D1 中间回归：25 个 TypeScript 测试文件共 112 项通过、2 项跳过；35 项默认 Rust 测试和 1 项显式完整 ECDICT 源对照通过，`cargo fmt`、零警告 Clippy、ARM64/x86_64 Android debug 构建通过。
- API 35 完成修正版固定源联网预载、取消清理、英中搜索、真实 Economist EPUB 点词、用户库零写入和冷启动持久化；华为 API 31 随阶段 D 集中批次补齐修正版完整计数、映射摘要和重新预载复验。

- 增加 Tauri command 映射、结构化错误脱敏和 Rust 探针持久化测试；真机验证写入、前后台、强制结束、重启读回与 Vite HMR。最终 19 个 TypeScript 测试文件通过，95 项通过、2 项跳过，5 项 Rust 测试通过。
- 阶段 B 最终回归：21 个 TypeScript 测试文件共 99 项通过、2 项跳过，16 项 Rust 测试通过，`cargo fmt` 与零警告 Clippy 通过，Windows NSIS 打包通过。
- 华为 API 31 ARM64 真机验证首次建库、覆盖安装与冷启动持久化、Keystore 密文落盘、日志脱敏、HTTPS 成功/超时/取消/离线、系统代理无直连回退及 debug 恢复出厂；API 35 x86_64 模拟器验证建库、Keystore 和冷启动持久化。两种 ABI 的原生库均为 16 KiB LOAD 段对齐。
- 阶段 C 在华为 API 31 与 API 35 模拟器使用外部 `TheEconomist.2026.07.11.epub` 验证 20 栏目/76 文章、正文图片、重复导入、选择器取消和冷启动锚点恢复；样本未进入 Git 或构建产物。
- 阶段 C 最终回归：22 个 TypeScript 测试文件共 104 项通过、2 项跳过，真实 2026-07-11 EPUB 接受测试单独通过；24 项 Rust 测试、`cargo fmt`、零警告 Clippy、ARM64/x86_64 Android debug 构建和 Windows NSIS 打包通过。
- 阶段 D0 最终回归：24 个 TypeScript 测试文件共 111 项通过、2 项跳过，30 项 Rust 测试、`cargo fmt`、零警告 Clippy、ARM64/x86_64 Android debug 构建和 Windows NSIS 打包通过；华为 API 31 与 API 35 均完成小型词典包、token 交互、TTS 与 Web 音频验收，API 35 额外完成 1.5 倍系统字体和横屏检查。
- 阶段 D 华为 API 31 核心真机回归：固定 ECDICT 59,119 词元/67,810 词形、英中搜索、真实文章多候选和 100 次点词零用户库写入；`futile` 收藏/取消/再收藏与删除词典后的快照恢复；revealed 强停恢复、双击版本冲突、1 条 FSRS 事件和 2 条强化事件；Home/冷启动/覆盖安装、1.0–1.5 倍字体、横屏、内存与日志检查均通过。
- 阶段 D 最终回归：25 个 TypeScript 测试文件共 115 项通过、2 项跳过，41 项 Rust 测试通过、1 项完整仓库外 ECDICT 源测试按设计忽略；`cargo fmt --check`、零警告 Clippy、ARM64/x86_64 Android debug 构建和 Windows NSIS 打包通过。

## 1.0.0-alpha.1 - 2026-07-11

### Changed

- 建立正式产品身份：包名改为 `foreign-press-reader`，应用 ID 改为 `com.local.foreignpressreader`，产品名和窗口标题统一为“外刊阅读器”。
- Windows 安装包改为 `ForeignPressReader-1.0.0-alpha.1-Setup.exe`，正式数据目录固定为 `%APPDATA%\外刊阅读器`。
- 将当前完整用户数据库结构折叠为不可改写的 `formal-v1` migration 1，并将便携备份重新建立为正式 format v1；Sync Model v1 和内容 ID v2 保持不变。
- 抽离 `AppDatabase` 连接、迁移、完整性检查与安全备份生命周期；便携、同步、存储、开发与领域 repository 改为依赖窄数据库能力端口。
- 将 renderer 的 `AppApi` 拆分为书库、阅读、语音、词典、学习等 11 个可组合能力接口，运行时 IPC 结构保持不变。

### Breaking

- 正式应用使用全新数据基线，不读取、迁移或删除旧 Demo 数据，也不导入 Demo format v5-v7 备份。旧 `%APPDATA%\外刊阅读器 Demo` 目录保持原样。
- 从本版本开始，正式 migration、便携格式、同步模型和内容 ID 按各自版本承担长期兼容责任；后续只能通过新增版本演进。

### Tests

- 覆盖正式建库、迁移回滚、同步触发器、旧/高版本只读拒绝、安全备份内容与失败清理、便携 format v1 幂等恢复及打包版跨重启设备身份持久化。

## 0.8.8 - 2026-07-11

### Fixed

- 百度长释义按词性改为分号连接的紧凑段落，默认显示前六项并支持展开、收起，不再形成过长编号列表。
- 百度考试标签不再进入词条合并；考试词集、Oxford/Collins 与词频统一只使用 ECDICT 基座数据，并对中英文别名做语义去重。

### Changed

- “词典服务”合并为单一设置卡片，本地与在线配置使用无嵌套卡片的区段布局，移除红色顶部装饰和内部状态框描边。
- 在线词典设置仅在 ECDICT 标准包或完整包已安装时显示；删除本地基座后隐藏，但保留已有百度偏好与加密凭据。
- 数据库 schema v4、ECDICT schema v4、百度缓存 v2、便携 format v7 和同步模型保持不变。

### Tests

- 增加长释义折叠、ECDICT 标签别名去重、百度标签隔离、单卡片设置和删除基座后隐藏在线配置的 Electron 回归测试。

## 0.8.7 - 2026-07-11

### Fixed

- 百度词典结果归一化为单一词头和按词性分组的中文义项，去除重复释义并忽略无需展示的英文定义；例句继续去重并限制为两条。
- 百度增强结果与 ECDICT 稳定词元合并，保留考试词集、Oxford/Collins、词频与词形；百度失败时继续按设置回退本地。
- 阅读器抽屉的长单词标题、发音和收藏操作允许安全换行，不再互相覆盖。

### Changed

- 设置侧栏统一为“翻译服务”“词典服务”“语音服务”；词典服务拆分为本地词典与在线词典两张卡片，百度密钥分别显示前后四位脱敏摘要。
- 设置布尔项改用红色主题开关，学习来源和词典筛选改用胶囊多选，书库列表选择不再使用浏览器默认蓝白复选框。
- Google 与 MiniMax 配置卡只在被单词发音或文章朗读选中时显示；同一供应商同时用于两个场景时只展示一次。
- 百度可再生查询缓存升级到 `baidu-v2`；数据库 schema v4、ECDICT schema v4、便携 format v7 与同步模型保持不变。

### Security

- 百度 API Key 与 Secret Key 的 IPC 状态只包含前四位、遮罩和后四位，renderer 不接收完整凭据。
- 真实百度连接验证仅通过临时进程环境使用凭据，未写入源码、测试、日志、备份或安装包。

### Tests

- 增加百度中文义项净化、本地元数据合并、长词无重叠、词典双卡片与条件语音卡片回归测试，并完成真实 `administration` 查询验证。

## 0.8.6 - 2026-07-11

### Added

- 接入百度智能云“文本翻译-词典版”，使用 DPAPI 分别保护 API Key 与 Secret Key；百度不可用时可自动回退本地。
- ECDICT 改为 `standard-v1` 基础学习包与可独立安装/卸载的完整定义扩展，支持无损升级和即时降级。
- 新增 64 MiB 百度查询缓存；收藏词条和当前每日学习卡可固化最多两条例句，并支持可选模型翻译。

### Changed

- “本地词典”更名为“词典服务”；用户数据库迁移到 schema v4，便携备份升级为 format v7。
- 旧单文件 `ecdict.sqlite` 需在词典服务中重新安装为标准学习包或完整包。

### Security

- 百度凭据、Access Token、原始响应与临时 TTS URL 不进入日志、数据库、IPC、备份或安装包。

### Tests

- 覆盖 ECDICT base/full 分层切换、百度嵌套 JSON/Token/缓存、schema v4、便携 v7、同步和每日例句补全。

## 0.8.5 - 2026-07-11

### Added

- 语音合成重构为真正的 `SpeechProviderAdapter` 协议适配器；保留 Google Standard，并接入 MiniMax 中国站同步 T2A，支持 `speech-2.8-turbo` / `speech-2.8-hd` 和多种英文系统音色。
- 新增统一的跨供应商语音缓存：按供应商、模型、声音、语言、语速和文本摘要隔离，合并并发请求，原子落盘并执行 256 MB LRU 回收；系统 TTS 继续不落盘。
- “数据与存储”新增四类空间扫描、分级缓存清理和跨设备同步占位卡片；必要文件会统计已安装的 Electron、可执行文件和打包资源，且始终不可清理。
- 新增会话内隐藏的“开发与调试”入口、开发模式门控、脱敏轮转日志，以及带精确路径保护和独立退出 helper 的恢复出厂流程。

### Changed

- “数据管理”更名为“备份管理”；语音设置改为场景分配、通用播放、系统语音和注册表驱动的远程供应商卡片。
- 远程语音偏好改用通用 `providerSettings`，兼容读取旧 `googleVoiceId`；数据库继续使用 schema v3，便携备份继续使用 format v6。
- 每日学习调试操作迁入“开发与调试”；关闭开发模式会同时关闭日志写入，但保留已有日志文件。

### Security

- MiniMax 仅使用中国站 `api.minimaxi.com`，密钥存入独立的 `minimax-tts` DPAPI 槽；日志不记录鉴权、正文、文章或单词文本、音频、URL 查询参数和完整本地路径。
- 恢复出厂仅删除经过一次性授权的精确用户数据目录，不删除已安装程序或用户导出到其他位置的 `.fprbackup`。

### Tests

- 覆盖 Google 行为、MiniMax 中国站请求和 MP3 十六进制解析、旧偏好升级、跨供应商缓存隔离/并发/LRU、存储分类和分级清理、隐藏入口、日志脱敏轮转与恢复出厂路径保护。

## 0.8.3 - 2026-07-11

### Added

- 新增平台无关的 `NetworkClient` 端口与唯一的 Electron 网络适配器；应用启动时刷新 Chromium 的系统代理配置，未来 Android/Tauri 可在不修改业务服务的前提下提供平台适配。

### Changed

- Google TTS、DeepSeek/OpenAI/Kimi 翻译、DeepSeek 文中义和 ECDICT 在线下载全部通过同一个 Electron Chromium 网络栈发出，统一继承 Windows 系统代理、PAC 与代理软件写入的端口配置。
- ECDICT 下载移至主进程统一网络层，worker 只负责本地 CSV/lemma 建库；保留流式进度、镜像回退、Git blob 完整性校验、取消与原子替换。
- 不读取或写死 v2rayN、代理软件名称、监听端口或 `HTTP_PROXY` 环境变量；未启用系统代理时 Chromium 直接连接，因此普通本地功能和离线阅读没有额外网络开销。
- 数据库继续使用 schema v3，便携备份继续使用 format v6，ECDICT 索引继续使用 compact-v3；本版无持久化迁移。

### Tests

- 新增架构守卫，禁止业务与 renderer 绕过 `NetworkClient` 直接调用全局 `fetch`，并验证四类公网能力均由同一个 Electron 适配器注入。
- 完整类型检查、领域/迁移/安全测试和 Electron UI 媒体 CSP 测试继续覆盖代理修复与 Google 音频播放路径。

## 0.8.2 - 2026-07-11

### Fixed

- Google TTS 与远程翻译供应商请求改用 Electron Chromium 网络栈，自动继承 Windows 系统代理、PAC 与 HTTPS 隧道；通过 v2rayN 系统代理访问 Google、OpenAI、Kimi 等服务时不再要求从带 `NODE_USE_ENV_PROXY` 的 PowerShell 启动。
- 内容安全策略显式允许应用自身创建的 `blob:` 音频，修复 Google 已成功返回 MP3、连接测试正常，但 renderer 立即报告“Google 语音音频播放失败”的问题。

### Tests

- 增加主进程必须通过 `electron.net.fetch` 路由远程语音和翻译的架构回归检查，以及真实 Electron renderer 对 `blob:` WAV 解码的 CSP 回归测试。
- 使用本机已加密保存的凭据完成不泄密诊断：无代理环境变量时系统代理连接成功，Google 返回有效 MP3，Chromium 实际经历 `playing → ended`；诊断凭据与音频不写入仓库、日志或安装包。

## 0.8.1 - 2026-07-10

### Added

- 语音层新增可扩展供应商注册表，首个远程适配器接入 Google Cloud Text-to-Speech REST API，并仅提供 `en-US` / `en-GB` Standard 基础声音。
- “语音朗读”设置可分别选择单词/词条发音与文章/段落朗读服务；单词默认系统语音，文章默认 Google，系统声音和 Google Standard 声音分别配置。
- Google TTS API Key 使用现有 DPAPI 分槽加密存储，可在设置中保存、删除和连接测试；密钥只在主进程解密，并通过 `x-goog-api-key` 请求头发送。

### Changed

- 书库图标视图完整换行显示长刊名；选择模式移除封面角落勾选框，以双层红色轮廓和轻微浮起表示选中。
- 每日学习卡增大宽度与高度，扩充内容留白并下移答题按钮；阅读器底部播放器改用统一 SVG 控件、分组状态和等宽进度数字。
- 翻译模型保存区与 API Key 区增加垂直间距；已保存密钥的脱敏显示同时保留前四位和后四位。
- 语音偏好继续保存在 `speech.preferences` 并进入便携备份；局域网同步携带服务选择与 Google 声音，仍保留接收设备自己的系统声音 ID。数据库 schema v3 和 `.fprbackup` v6 均不变。

### Security

- Google TTS 文本与密钥只经 Electron 主进程发出，renderer 不直接访问网络或密钥；上游错误不会回传响应正文。
- 用户提供的测试密钥未写入源码、测试、日志、备份、安装包或 Git 历史。

## 0.8.0 - 2026-07-10

### Added

- SQLite 顺序迁移至 schema v3，新增刊物生命周期、逐词学习进度重置墓碑、单调 revision、合并式实体 revision 索引、peer 游标和批次回执；可同步表通过事务内触发器登记变化。
- 建立平台无关的 Sync Model v1、稳定 camelCase 逻辑 DTO、`newer-wins` / `incoming-wins` 合并策略，以及快照/增量选择、确定性批次和依赖顺序的无网络 loopback 测试基础。
- 阅读位置增加稳定 block、token 与块内比例锚点；旧位置继续保留像素 `scrollTop` 回退。
- 新增长期同步开发路线文档，固定发送端胜出、显式墓碑、内容寻址 EPUB、Android/Tauri 适配和后续局域网协议方向。

### Changed

- 删除整本刊物时保留 `deleted` 生命周期墓碑，重新导入时写回 `present`；内部失败补偿仍可清除本次未完成导入而不制造用户删除。
- 删除计划并重置进度时记录逐词墓碑，阻止旧备份恢复重置前的卡片、事件和暂停状态。
- `.fprbackup` 导出升级为 format v6，加入刊物生命周期、逐词重置和阅读锚点，并将学习记录改为稳定 camelCase 字段；继续通过兼容适配器导入 format v5。
- 全量便携备份继续采用后写优先逻辑合并，不导出 revision、peer 游标、批次回执、设备身份、密钥、词典或缓存。

### Not included

- 本版本只交付同步数据基础与无网络测试内核；局域网发现、配对、HTTPS 传输、接收确认、进度界面和 Android 客户端仍未实现。

## 0.7.6 - 2026-07-10

### Added

- 新增 `pnpm perf:smoke` Windows 发布版性能基准，使用隔离的合成书库和词典记录 Electron 进程组私有提交、工作集、CPU、renderer 堆与 DOM，并输出 JSON 报告。
- 增加 EPUB 文件 worker 快速路径与词典查询 worker 闲置回收回归测试。

### Changed

- 四个一级功能区改为“保留轻量状态、卸载隐藏 DOM”：继续恢复文章/词条/计划/设置子页、非敏感草稿与滚动位置，但不再让文章正文、查询结果和页面副作用同时常驻。
- 阅读器词元 HTML 按段缓存，当前词元高亮不再重新解析整段；离屏文章块延迟布局，文章图片与书库封面使用延迟加载和异步解码。
- ECDICT 查询 worker 在无待处理请求后闲置 60 秒自动退出，并在下一次查询时透明重启。
- EPUB 文件由解析 worker 直接读取，图片缓冲区通过 transferable 返回；便携备份的 Archiver、Yauzl 和兼容 JSZip 改为实际使用时动态加载。

### Performance

- 本机 Windows 11 / 15.7 GiB 内存发布版基线显示：冷启动约 230 MiB 私有提交，普通文章约 294 MiB，文章与词典 worker 同时启用约 357 MiB；闲置 10 秒未观察到 CPU 增量。
- 优化后的隔离性能 smoke 实测为冷启动 214.89 MiB、文章 292.12 MiB、词典活跃 314.46 MiB；最后十次文章切换仅增长 0.85%，回收后 renderer 堆较冷启动增加 0.82 MiB，闲置 CPU 0.02%，EPUB 文件快速路径相对旧复制流程降低 31.91% 峰值。
- 性能判定改为观察整个 Electron 进程组，并区分可共享工作集、私有工作集和私有提交；不通过关闭 GPU、强制垃圾回收或频繁清空 Chromium 缓存降低表面数字。

## 0.7.5 - 2026-07-10

### Added

- “我的书库”新增文件管理器式分类栏和管理工具栏，支持建立、重命名、删除分类，并将书籍单本或批量移动到分类/未分类。
- 书籍支持安全重命名、单本删除、选择/全选和批量删除；删除会同时移除本地原始文件、数据库内容及可再生缓存。
- 书库新增名称/导入时间排序、正序/倒序和图标/列表视图，所选分类、排序与视图偏好均持久化。
- 书库、词典、背单词和设置四个一级功能区访问后保持挂载，切换时恢复各自上次页面、表单状态和滚动位置。

### Changed

- 书库分类、自定义书名、排序和视图状态保存到现有 `library.management` 设置，并进入 `.fprbackup` v5 的后写优先合并；不改变数据库 schema 或便携格式版本。
- 阅读器和学习会话仅在所属一级功能区可见时响应全局快捷键，避免保活页面之间争用键盘事件。

### Fixed

- 书库连续快速执行分类、视图切换和重命名时忽略迟到响应，避免旧状态覆盖较新的界面结果。

## 0.7.0 - 2026-07-10

### Added

- 翻译服务新增供应商与模型注册表，内置 DeepSeek、OpenAI、Kimi（Moonshot），可在设置中手动选择供应商和模型；默认继续使用 `deepseek-v4-flash`。
- OpenAI 内置低成本 `gpt-5.4-nano` 与 `gpt-5.4-mini`；Kimi 内置 Moonshot V1 8K/32K/128K 与 Kimi K2.6；DeepSeek 补充 V4 Pro 选项。
- 新增出版物格式注册表与 EPUB 来源 Profile 注册表。当前只注册 EPUB 格式，继续优先适配 Economist，并保留通用 EPUB 回退；后续格式与来源无需改动书库主流程。

### Changed

- API 密钥改为按供应商独立 DPAPI 加密保存；旧版单 DeepSeek 密钥文件可继续读取，并在下次写入时升级。
- 翻译偏好写入现有 `settings` 表并进入 `.fprbackup` v5 的设置合并；供应商密钥和翻译缓存仍不导出。
- 翻译请求、模型列表连接测试、错误提示和缓存键均按当前供应商与模型路由；不改变数据库 schema、词典索引 schema 或便携格式版本。

## 0.6.2 - 2026-07-07

### Changed

- 学习会话将单词卡内容区与底部操作区分离，避免“认识 / 不认识 / 继续”等按钮随释义内容增减上下跳动。
- 浅色阅读背景改为更统一的米白纸张，并在“设置 → 阅读外观”新增浅色纸张暖度调节与恢复默认。
- “设置 → 每日学习”重排高级设置、调试区和保存区：学习日切换时间改为滑块，FSRS 参数输入框改为紧凑统一样式，保存按钮改为有改动才启用的独立保存条。

### Fixed

- 弱化“开发与调试”区域的危险视觉层级，仅保留破坏性操作按钮的危险样式。

## 0.6.1 - 2026-07-07

### Fixed

- 搜索高亮样式改为运行时注入，保留 Custom Highlight API 行为，同时避免 renderer 构建阶段的 `::highlight(...)` 解析警告。

### Changed

- 版本升级至 `0.6.1`，安装包继续使用 Windows x64 NSIS 覆盖安装策略。

## 0.6.0 - 2026-07-07

### Added

- 新增统一系统语音层与 Web Speech 平台适配器，支持语音枚举延迟、系统默认英文回退、长文本分片、全局单队列和播放状态控制。
- 阅读器新增从当前可见段落开始的连续朗读、段落悬浮发音、当前段高亮及底部播放器；查词抽屉可朗读实际点击词形。
- 词典详情和每日学习卡新增发音按钮；每日学习可选择每张新卡自动朗读一次，默认关闭。
- 设置页新增英语地区、系统声音、0.5–2.0 倍语速、学习自动发音与试听设置。

### Changed

- 系统语音偏好使用现有 `settings` 表持久化并进入 `.fprbackup` v5；用户数据库 schema 和便携格式版本不变。
- 统一全局“现代报刊编辑部”UI 体系，覆盖侧栏、书库、阅读器、词典、背单词、设置及其内部菜单，补齐浅色/暗色主题、响应式布局、焦点态和可访问操作反馈。
- 设置页改为“分类侧栏 + 当前分类内容”；词典改为统一分段导航与双栏工作台；背单词计划详情改为模块内子页面，并补充学习会话快捷键提示。
- 版本升级至 `0.6.0`，安装包继续使用 Windows x64 NSIS 覆盖安装策略。

## 0.5.9 - 2026-07-07

### Fixed

- 长期计划详情页搜索框增加自动聚焦、点击焦点恢复和更高层级，降低更新后首次打开时输入框偶发无法获得焦点的问题。
- 开发模式下删除计划不再被其他未完成今日任务全局阻塞；删除时会移除该计划相关的未完成队列项，避免当前学习队列卡住。

### Added

- 长期计划详情页开发删除改为应用内确认弹窗，可选择“仅删除计划”或“删除计划并重置相关单词学习进度”。
- 选择重置时，会清除该计划涉及单词的复习卡、复习事件、强化事件、暂停复习状态和学习队列项，但保留生词、词条快照和收藏语境。

## 0.5.8 - 2026-07-07

### Changed

- ECDICT 本地索引升级为 schema v3 / compact-v3，内部改用整数 `lexeme_id` 关联，外部继续使用稳定 `LexemeKey`。
- 中文反查 FTS 改为 contentless 轻量索引，只保存必要 token，不再重复保存完整释义和 definition 文本。
- 设置页词典状态改为显示“本地索引”大小；旧 schema v2 词典会被视为需要重新安装。
- 完整 ECDICT 本地索引体积实测约 286.8 MiB，低于 v0.5.7 的约 549.8 MiB。

## 0.5.7 - 2026-07-07

### Added

- 新增今日学习主卡片、完成总结、可筛选今日词表和计划熟练度环形筛选。
- 新增认识后的释义确认与误判纠正、“太简单”全局暂停复习，以及独立不可变强化事件。
- 新增混合/复习优先/新词优先队列、频率加权确定性新词选择和稳定随机强化插入。
- 设置页新增学习调度设置和本地开发模式；开发模式支持计划软删除、重置算法进度和模拟下一学习日。

### Changed

- Dashboard 改为纯用户数据库查询；考试词集使用版本化来源同步，避免进入页面时扫描完整词典。
- 计划词表统一搜索、筛选和分页状态，并忽略迟到响应；计划诊断支持待复习、熟练度、暂停及排除筛选。
- SQLite 顺序迁移至 schema v2，保留 v0.5.6 书库、计划、卡片及历史；便携备份升级为 format v5。

## 0.5.6 - 2026-07-07

### Fixed

- 学习计划同步考试词集时改用分页联表批量读取，避免逐词查询完整详情长期占用词典 worker，导致保存按钮持续禁用及词典页面暂时无法加载。
- 未变化的计划词源不再重复重写成员与学习来源，降低每次进入“背单词”页面时的数据库开销。
- 词典初始化期间显示统一忙碌状态；补充空计划名称失败后可立即重试的 Electron 回归测试。

## 0.5.5 - 2026-07-07

### Added

- 新增左侧栏“背单词”，提供长期计划、今日合并队列、可恢复学习界面和计划统计后台。
- 学习计划可组合“我的生词”和多个 ECDICT 考试词集，支持每日新词/复习配额、两种新词顺序、暂停、归档及逐词排除。
- 接入 `ts-fsrs` 5.4.1 / FSRS-6：每个 LexemeKey 只有一张全局复习卡，并记录不可变复习事件与 D/S/R 诊断信息。
- 增加答错后连续认识两次的当日强化、跨日结转、凌晨 4 点学习日、时区固定、复习积压及完成后的额外批次。

### Changed

- 建立不兼容的 `v0.5.5-study-baseline` SQLite schema generation；旧开发数据库只明确拒绝，不自动删除或迁移。
- 便携备份升级为 format v4，加入计划、来源、排除、FSRS 配置、复习卡和复习事件，并排除活动 session 与队列。
- 用户词汇快照增加分组释义和词频信息，使每日学习不依赖 ECDICT 持续安装。

## 0.5.0 - 2026-07-07

### Added

- 阅读器词典抽屉新增独立的“收藏生词”和“收藏语境”操作；收藏生词会同时保存当前语境。
- 新增稀疏的全局用户词汇、可扩展词汇来源和带墓碑的收藏语境模型。
- 词典中心新增“我的生词”，即使 ECDICT 暂未安装也可读取收藏时保存的词条快照。
- 新增独立 `VocabularyService`，为文章批量导入、考试词集和未来学习计划保留统一来源边界。

### Changed

- 普通查词改为纯查询，不再写入语境、事件或统计；文中义 AI 缓存仍作为可再生缓存保留。
- SQLite 顺序迁移至 schema v2，保留 v0.4 书库、阅读位置、翻译和设置，丢弃原自动查词历史。
- 便携备份升级为 format v3，导出用户词汇、词汇来源和收藏语境及其取消墓碑。

本项目使用语义化版本的 `0.x` 阶段约定：次版本表示新增能力或数据迁移，修订版本表示兼容性修复。

## 0.4.0 - 2026-07-06

### Added

- 独立词典中心，支持英中双向搜索、考试词集、高级筛选、词条详情和查词语境回链。
- 稳定 LexemeKey、词形歧义候选、不可变查词事件和 ECDICT 规范化索引。
- ECDICT 查询 worker、EPUB 解析 worker、导入进度/取消和原子 staging。
- Generic EPUB 与 Economist 来源 Profile 边界、内容 ID v2 和 Windows CI。

### Changed

- 建立不兼容的 SQLite v0.4 schema generation，旧开发数据库不再自动迁移。
- 便携备份升级至 format v2，分别导出查词语境与不可变事件。
- 书库导入公共 API 从 `importEpub` 更名为 `importPublication`。

## 0.3.2 - 2026-07-06

### Added

- 当前文章搜索和 `Ctrl+F`、`F3`、`Shift+F3`、`Esc` 快捷键。
- 中文查询可搜索已有译文，并仅在搜索期间展开命中的译文。

### Changed

- 词典抽屉改为宽屏正文让位、窄屏覆盖，工具栏不再随抽屉移动。
- 字号、栏宽、窗口和词典布局变化时保持当前查词词元或视口中心内容的位置。
- ECDICT 词性别名统一归组，领域标记、中文释义和英文 definition 使用一致格式。
- 文章图片宽度与当前阅读栏一致，并限制视口高度。

### Fixed

- 词典关闭动画缺失及频繁开关、调整窗口时阅读内容大幅跳动的问题。
- 词典开启时工具栏右上角出现空缺的问题。

## 0.3.1 - 2026-07-06

### Fixed

- EPUB 在便携备份中改为 STORE 流式写入，避免对已压缩内容再次 Deflate。
- 兼容读取 0.3.0 已导出的压缩 EPUB 备份，防止安装版导入预览时主进程异常中断。

## 0.3.0 - 2026-07-06

### Added

- 纯 TypeScript core、平台端口和 renderer AppClient 边界。
- SQLite v3迁移、设备标识、迁移历史、事务升级和迁移前快照。
- 按设备合并的查词计数器。
- `.fprbackup` 精简便携导出、预览和幂等合并导入。
- 核心边界、迁移快照和便携数据测试。
- 长期架构、数据政策和AI Agent接续文档。

### Changed

- EPUB核心二进制从 Node `Buffer` 改为 `Uint8Array`。
- EPUB和翻译服务迁入可移植核心层。
- renderer 通过平台客户端访问功能。

## 0.2.0 - 2026-07-06

- ECDICT本地词典、点击查词、词形还原、查询历史和手动文中义分析。
- 数据库从v1迁移到v2。

## 0.1.0 - 2026-07-06

- EPUB书库、目录、规范化阅读器和DeepSeek逐段翻译Demo。
