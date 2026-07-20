# 阶段 E2 + E3 Android 验证记录

日期：2026-07-13
分支：`codex/android-offline-dictionary`
状态：本机自动化、构建与 API 35 基础启动/主页视觉冒烟通过；E2/E3 尚未完成设备性能、完整视觉矩阵与华为真机门禁，不能标记为阶段完成。

> 后续状态：E4 在线/系统服务已在同日接通；本文件第 4、6 节保留为 E2/E3 当时的退出快照。当前证据与下一步以[阶段 E4 Android 验证](stage-e4-android-validation.md)和[功能对照账本](stage-e-mobile-parity-ledger.md)为准。

## 1. 本轮实现范围

### E2：词典与我的生词

- 冻结 `MobileDictionaryCenterClient v1`，继续兼容既有 `MobileLearningClient v1` 和 `DictionaryApi` / `VocabularyApi` DTO。
- 将移动词典拆为独立功能页面：词典检索/我的生词双模式、180 ms 防抖、latest-wins、总数与分页、考试词集、tag any/all、Oxford、Collins、BNC、当代词频和排序筛选。
- 增加手机全页词条、收藏语境、原文章深链和无词典时的用户快照降级；同时新增并测试共享纯 TypeScript presentation builder，用于统一标签去重、词性分组、长释义折叠、词形、例句和快照降级。Windows 词典与移动全页详情已接入，阅读/学习移动深链复用该详情；桌面阅读器抽屉仍待 E5 收口。
- 词典资源状态改为快速 manifest/file generation 路径；普通进页、搜索和点词不再执行 `quick_check` 或全量词元哈希。深度校验只用于显式修复、安装发布前或 generation 变化后的校验，并在 Rust 阻塞线程执行。
- 增加运行时只读资源缓存与 generation 失效；安装、修复、降级、删除后重新打开资源，发布失败时继续保留旧有效 generation。
- 保留 `standard-v1` 与 `.fprdict` v1；增加独立 `full-extension-v1`，要求 dataset revision 与 `lexemeMapHash` 匹配基础包，不兼容扩展不影响标准包。
- 词典设置接通点击查词、本地 standard/full 安装、空间预检、修复、降级、删除和取消。百度增强、AI 文中义、例句翻译与语音仅暴露 E4 capability 槽位；未配置时明确禁用，不发起网络请求或伪装成功。

### E3：今日学习与长期计划

- 冻结 `MobileStudyManagementClient v1`；跨计划去重、按计划配额选词、三种队列顺序、carryover/deferred-new、额外批次、FSRS transition 和强化插入继续由 `src/core` 纯 TypeScript 计算。
- 增加 study queue/review envelope v2，携带状态指纹、canonical FSRS 参数和参数 fingerprint；Rust 验证提案后，以 `commandId + expectedVersion` 在事务中提交。既有 v1 队列和 review proposal 继续接受与回放，以保持 D3 兼容。
- 增加移动 dashboard、计划创建/编辑、我的生词与考试词集来源、来源同步、启用/暂停/归档、进度分布、计划词表、D/S/R、due/reps/lapses、逐词排除和暂停复习。
- 增加今日预览、活动 session 优先恢复、new/review/carryover、两阶段回答、认识后改判、答错后连续认识两次、太简单与 6 秒撤销、今日历史筛选和按计划再学一批。
- 每日学习设置接通混合/复习优先/新词优先、cutoff 0–23、目标记忆率 0.80–0.95、最长间隔 30–36500 天；保存值只影响下一批任务。
- 硬删除计划、全量学习重置和模拟学习日仍属于 E4 开发者能力；普通用户只使用启用、暂停和归档。

### 共享壳与深链

- 移动壳快照升级为 v2，并保留 v1 安全恢复映射。
- 词条路由带 `hostTab`，从词典或学习打开详情后 Back 返回来源栈；安全的计划详情、编辑和今日词表状态可恢复，活动答题 session 不持久化。
- 移动壳继续只负责路由、全局任务和共享深链；词典、学习与设置页面已拆为独立模块。

## 2. 自动化与构建门禁

本文件只记录已经得到命令输出支持的结果。本机自动化与构建结果如下；设备性能与视觉结果单独记录在第 3 节，不能用本机门禁替代。

| 门禁 | 当前结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 34 个测试文件；165 项通过，2 项按设计跳过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --all-targets` | 54 项通过，1 项仓库外完整 ECDICT 源测试按设计忽略，0 失败 |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过，零警告 |
| Android ARM64 debug APK | 通过，生成 aarch64 split debug APK |
| Android x86_64 debug APK | 通过，生成 x86_64 split debug APK |
| `pnpm dist` | 通过，Windows x64 NSIS 构建完成 |
| `git diff --check` | 通过 |

本轮新增或扩展的自动测试目标包括：

- 共享词条 presentation 的标签去重、词性分组、长释义、词形、例句和快照降级。
- `MobileDictionaryCenterClient v1`、`MobileStudyManagementClient v1`、E4 禁用 capability 与 Tauri camelCase 边界。
- shell v2 的 v1 映射、`hostTab` 深链、计划/词条返回栈，以及活动学习 session 不持久化。
- standard/full 资源匹配与不匹配、fast/deep 校验隔离、缓存失效、空间预检、取消和失败回滚。
- 筛选、排序、分页、无资源快照，以及普通查词零用户库写入。
- 固定时钟/seed 的多计划去重、三种队列顺序、结转、额外批次、强化、改判、too-easy 撤销、下一批设置和 v1/v2 proposal 兼容。

移动 E2/E3 定向 Vitest 回归为 6 个测试文件、36 项通过；全量 `pnpm test` 的数字以上表为准。自动测试和本机构建门禁已经通过，但不能替代下面的设备性能与视觉证据。

## 3. 性能门槛与设备证据

E2 的目标门槛保持不变：词典骨架 P95 ≤ 100 ms，warm 进入 ≤ 50 ms，API 35 冷进入 ≤ 150 ms，华为 API 31 冷进入 ≤ 250 ms；英文搜索 P95 ≤ 250 ms，中文/组合筛选 ≤ 400 ms（另计 180 ms 防抖），warm 词条详情 ≤ 200 ms。连续 100 次进入词典和 100 次点词时，trace 中 `quick_check`/全量哈希次数必须为 0，不能出现超过 500 ms 的 UI 主线程停顿或陈旧结果覆盖。

截至本记录更新时：

- API 35 x86_64 AVD 已覆盖安装最终 debug APK，冷启动进入正式 WebView；词典主页正确显示已安装的 59,119 词元/67,810 词形标准包、考试词集与筛选入口，背单词主页正确显示今日卡片、长期计划和四项底部导航，未见 fatal/panic。该项仅是基础启动与主页视觉冒烟，不替代下面的性能和尺寸矩阵。
- 在该 API 35 AVD 的最终 debug APK 上，使用 DevTools 单调时钟重复测得：100 次进入词典骨架 P95 75 ms（最大 89.2 ms）；100 次 warm 资源状态 P95 34 ms；100 次英文 `state` 搜索 P95 74 ms；50 次中文 `状态` + CET4/BNC 组合筛选 P95 74.1 ms；100 次 warm 词条来源/详情 P95 134.7 ms。以上项目达到各自 warm/P95 目标，并验证英文 exact/form/prefix 改为索引 UNION 后不再出现原 OR 查询规划退化。
- 尚未取得本轮 API 35 的正式冷状态 trace、100 次真实点词 UI trace、主线程 jank/`quick_check` 计数 trace 或完整确定性视觉矩阵证据；自动 Rust 测试已验证 fast status 不执行数据库完整性和词元哈希扫描，但不能替代设备 trace。
- 尚未取得华为 OCE-AL50 / API 31 的本轮冷启动、搜索、详情、字体、横屏、键盘、TalkBack 和真实性能证据。
- 尚未记录 360×800、412×915、横屏、600/840 dp、浅深色、字体 1.0/1.3/1.5 的本轮完整截图审计。
- 因此不能声称上述 P95、主线程停顿、视觉或真机门槛已经通过。相关项目应进入 E2/E3 设备验证批次，并在阶段完成前补回本文件。

## 4. 在线服务与发音边界

- 百度在线词典、AI 文中义、例句翻译和远程/系统发音本轮没有新增网络、密钥或音频端口实现。
- UI 按 capability 渲染不可用状态，说明“E4 提供”或“未配置”；没有返回假释义、假音频或假成功。
- 后续 E4 接入时仍必须经过受控网络适配器与 Android Keystore；密钥不得进入 renderer、日志、错误、测试快照或 IPC 返回值。

## 5. 架构与数据审计

- `src/core` 的新增学习规划与词条 presentation 保持纯 TypeScript；Rust 只负责候选快照、版本指纹、提案验证、资源查询和事务落库。
- renderer 通过版本化移动客户端调用逻辑 DTO，不获得私有路径、任意 SQL、任意文件系统、任意 URL 或原生插件权限。
- 没有改写 `formal-v1` migration 1、正式便携备份 format v1、Sync Model v1 或内容 ID v2；本轮不需要新增正式数据库 migration 或便携/同步格式版本。
- `full-extension-v1` 是可再生本地资源，不进入便携备份或同步。
- 正式应用不读取、迁移或删除旧 Demo 数据。
- 当前 `git status --short` 差异审计未发现 EPUB、用户数据库、真实 ECDICT、密钥、备份、日志、截图、APK、NSIS 或其他构建产物；提交前仍应复核一次。

## 6. 结论与下一步

E2/E3 的共享契约、页面、Rust 能力和纯 TypeScript 规划已经进入同一仓库的集成验证阶段；TypeScript/Rust 自动回归、Android 双 ABI debug 构建、Windows NSIS 分发构建和 API 35 基础启动/主页视觉冒烟已经通过。API 35 正式性能与完整视觉矩阵、华为 API 31 真机证据尚未补齐，因此阶段状态保持“实现完成度待验收”，不标记为正式完成。

通过全部门禁后才进入 E4：接通设置与在线/系统服务，并实现百度、AI 文中义、例句翻译和语音；随后由 E5 完成跨模块、生命周期、无障碍与完整覆盖审计。
