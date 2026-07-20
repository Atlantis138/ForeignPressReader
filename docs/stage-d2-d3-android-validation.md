# 阶段 D2–D3 Android 验证记录

> 日期：2026-07-13
> 分支：`codex/android-offline-dictionary`
> 状态：D2/D3 实现、自动测试、双 ABI 构建、API 35 与华为 API 31 核心真机验收通过

## 1. 实现范围

D2 完成阅读器词条/语境收藏、取消与再次收藏、最小“我的生词”列表、稳定来源/语境 ID、revision 触发和快照恢复。写入复用 `formal-v1` 的 `user_lexemes`、`vocabulary_sources` 与 `saved_contexts`；没有新增或改写 migration、便携 format v1、Sync Model v1 或内容 ID v2。

D3 完成以“我的生词”为唯一来源的最小计划、来源成员同步、今日队列、两阶段认识/不认识、FSRS 卡与不可变事件原子提交、`commandId` 幂等、`expectedVersion` 冲突拒绝、冷启动和跨学习日结转。队列与 FSRS proposal 仍由共享 TypeScript 计算，Rust 只校验 D0 固定契约并在单一 SQLite 事务中提交。

薄 UI 延续 D1 的移动视觉：书库增加“我的生词”和“今日复习”入口；词典底部面板增加收藏词条、收藏语境与返回生词列表；复习页只覆盖最小计划和单卡流程。完整计划管理、历史、筛选、考试词集和最终移动信息架构仍属于 E0/E2。

## 2. 自动测试

- `test-vectors/d2-vocabulary.json` 固定 Windows/Android 共用的来源 ID、句子 SHA 和语境 ID。
- Rust D2 测试覆盖重复收藏、取消墓碑、列表去重，以及删除原文章后仍从快照显示词条与语境。
- Rust D3 测试覆盖计划来源同步、固定队列、两阶段提交、相同 command 重放、错误版本冲突、review event 插入故障的完整事务回滚，以及 revealed 卡跨学习日结转。
- TypeScript 客户端测试确认 queue/FSRS proposal 在 renderer 的共享 core 中生成，Tauri 参数不包含路径、SQL 或 URL。
- 最终结果：25 个 TypeScript 测试文件，115 项通过、2 项跳过；Rust 41 项通过、1 项仓库外完整 ECDICT 测试按设计忽略；`cargo fmt` 与零警告 Clippy 通过。

## 3. API 35 x86_64 模拟器

设备：`ForeignPressReader_API_35`，Android API 35，x86_64，无窗口 WHPX AVD。

使用保留的阶段 C 真实外部书库和 D1 固定 ECDICT，完成：

1. 在真实文章点击 `Dig`，从 `dig` / `digging` / `dug` 多候选中确认 `dig`。
2. 收藏生词；该操作按既有 Windows 语义同时保存当前语境。按钮状态变为“已收藏生词/已收藏语境”。
3. 打开“我的生词”，显示 `dig` 的词条、音标、释义与收藏时间；Android Back 返回相同文章和等价阅读锚点。
4. 创建“我的生词计划”，来源成员为 1；重复入口冷启动后只恢复同一计划。
5. 打开逻辑学习日 `2026-07-12` 的 1 张新卡；模拟器系统时间为 2026-07-13 01:30，4 点 cutoff 计算正确。
6. 先点“认识”，确认只揭示释义和已保存原文语境；再点“确认认识”，完成原子提交。
7. 强制结束并冷启动后，“我的生词”仍显示 `dig`，今日队列仍为完成 1/1。

关闭进程后连同 WAL 读取数据库，得到：

| 表 | 记录数 |
| --- | ---: |
| `user_lexemes` / `vocabulary_sources` / `saved_contexts` | 各 1 |
| `study_plans` / `study_plan_sources` / `study_plan_lexeme_origins` | 各 1 |
| `study_sessions` / `study_session_items` | 各 1 |
| `review_cards` / `review_events` | 各 1 |
| `reinforcement_events` | 0 |

唯一 session item 为 `completed`、`version=3`、`fsrs_committed=1`、`attempt_count=1`；review event 的 answer/rating 为 `known/3`；`sync_clock.current_revision=22`。最近 300 行 logcat 未命中 panic、FATAL EXCEPTION、ANR 或学习数据库错误。

## 4. 华为 API 31 ARM64 真机

设备：Huawei OCE-AL50，Android API 31，ARM64，Huawei WebView 114.0.5.302。安装静态 debug APK 前后，现有 76 篇真实外部书库及用户数据库主文件/WAL 的 SHA-256 均保持不变。

### D1 复验

- 删除旧可再生资源后重新联网预载固定 ECDICT，得到 59,119 词元、67,810 词形和固定 `lexemeMapHash=b6e911b3…d2590a8f`；发布后 staging 为空。
- 搜索 `run` 得到 23 个词元/词形/前缀结果；中文“跑步”得到 `run`、`runner`、`trotter`。
- 在真实文章点击 `fighting` 并切换到 `fight` 候选；随后以每次重新取 DOM token 的方式连续点词 100 次，最后稳定显示 `futile` 及正确原句。
- 普通搜索和 100 次点词前后，用户数据库主文件与 WAL 的 SHA-256 完全一致。

### D2 复验

1. 在 `futile` 面板收藏生词；按 Windows 语义同时保存当前语境，两个按钮都进入已收藏状态。
2. “我的生词”显示词条、音标、释义和时间；返回后仍是同一文章，阅读容器锚点约为 518 px。
3. 取消后列表为空，再次收藏后数据库仍只有 1 个 `reader_manual` 来源、1 个 active 语境，来源唯一键没有重复组。
4. 删除 ECDICT 后，生词列表仍完整显示 `futile` 快照；随后重新预载固定资源，使设备回到可继续离线查词的状态。
5. Home、强制结束、冷启动和正确静态 APK 覆盖安装后，书库、生词与语境均恢复；覆盖安装前后用户数据库主文件/WAL 哈希不变。

### D3 复验

1. 由唯一 active 生词创建最小计划，逻辑学习日为 `2026-07-13`，今日队列为 1 张 new 卡。
2. 点“不认识”只写入 `revealed + proposed_answer=unknown`，此时 `review_events=0`、`reinforcement_events=0`。强制结束并冷启动后仍恢复已揭示释义、原句和“确认不认识”。
3. 对“确认不认识”做同一帧双击：第一笔成功，第二笔由版本冲突拒绝。随后连续确认两次“认识”，界面进入完成 1/1。
4. 关闭进程并连同 WAL 审计：仅 1 张 `review_card`、1 条 rating 1 的 `review_event`、2 条 known `reinforcement_events`；item 为 `completed`、`fsrs_committed=1`、`had_failure=1`、`attempt_count=3`、`consecutive_known=2`、`version=7`。
5. Home/前后台、强制结束、冷启动与覆盖安装后仍恢复同一计划和“今日完成”。

### 设备差异与运行状态

- 系统字体 1.0、1.3、1.5 倍及 1.5 倍横屏下，书库四个主入口均可见且无文字裁切；测试结束后已恢复字体 1.0、自动旋转和竖屏。
- Huawei WebView 114 下书库、目录、阅读、词典、生词和复习导航无死路；中文输入法自动化异常改用 WebView 调试协议复验查询逻辑，不改应用数据。
- 峰值观察约为 199 MB PSS / 358 MB RSS；完整 ECDICT 建库、100 次点词和三次学习提交期间无持续卡顿。
- logcat 未命中 panic、FATAL EXCEPTION 或 ANR；当前应用日志未命中数据库私有路径、API key、Authorization、请求/响应正文等敏感模式。进程退出记录仅包含测试触发的覆盖安装、强制结束和系统回收。

## 5. 构建与剩余边界

- ARM64 与 x86_64 Android debug APK 均构建通过；API 35 与华为 API 31 的安装、页面交互、冷启动和数据库核对通过。
- 真机未执行会影响用户手机全局状态或删除真实测试资产的飞行模式、低存储、删除刊物和手工改系统日期；对应离线、失败回滚、文章删除快照和跨日结转由自动化测试覆盖，仍保留为发布候选的可选破坏性复验项。
- 最终 `pnpm typecheck` 通过；25 个 TypeScript 测试文件共 115 项通过、2 项跳过；Rust 41 项通过、1 项仓库外完整源测试按设计忽略；`cargo fmt --check`、零警告 Clippy 与 Windows NSIS 打包通过。

因此 D2、D3 及阶段 D 的核心真机退出条件已通过；未执行的破坏性设备场景不阻塞进入阶段 E，但必须继续留在集中清单中，待专用测试设备或发布候选批次复验。
