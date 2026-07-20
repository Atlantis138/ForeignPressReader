# 阶段 D0–D3：Android 词典、生词与复习纵向切片实施计划

> 文档状态：D0–D3 实现、API 35 与华为 API 31 核心真机验收完成；阶段 D 已结束
> 前置基线：阶段 C 已完成；分支基线 `bae8099`
> 适用范围：Windows/Electron 对照端、Android/Tauri 2、远期 iOS 可复用边界
> 最后更新：2026-07-12

## 1. 结论

阶段 D 保留“点击单词 → 离线查词 → 收藏生词/语境 → 建立最小计划 → 完成一张复习卡 → 冷启动保留”的纵向目标，但拆为四个必须顺序验收的子阶段：

1. **D0：契约、算法归属与资源 spike**
2. **D1：离线 ECDICT 与阅读器点词查词**
3. **D2：生词与语境持久化**
4. **D3：最小计划、每日队列与一张 FSRS 卡**

在线翻译、百度词典、远程语音、完整词典中心、完整计划管理和最终移动视觉不属于 D0–D3 的退出条件。它们移入阶段 E 的独立功能覆盖批次，不能阻塞本地离线学习闭环。

### 1.1 D 阶段的 UI 与功能对齐

- D2/D3 仍使用可验收的薄移动 UI，但必须沿用 D1 已形成的移动端颜色、排版、间距、触摸目标，以及加载/空/错/确认模式，不再创建一次性页面风格。
- Windows 与 Android 对齐术语、逻辑 DTO、状态含义、信息优先级和操作结果；桌面侧栏/多栏与移动导航/底部面板不要求逐像素一致。
- 同一功能在 Android 尚未覆盖时应明确后置或标记不支持，不使用空返回或占位按钮伪装兼容。
- 阶段 E0 建立正式移动设计令牌、四项一级导航和信息架构；E1–E5 按书库阅读、词典生词、背单词、设置/在线服务和收口审计逐项记录“已覆盖、平台化调整、明确后置、不支持”，完成细节层面的产品统一。

每个子阶段使用独立短期分支、兼容向量、API 35 模拟器和 Electron 回归；只有前一子阶段的自动测试、模拟器门禁和数据契约通过后，才开始下一子阶段。华为 API 31 项目随 D0–D3 累积到[Android 集中真机测试清单](android-device-test-backlog.md)，在 D3 完成后集中执行，不要求真机长期在线。

D0 已于 2026-07-12 验收完成，详细结果见[阶段 D0 Android 验证](stage-d0-android-validation.md)。D1 实现、完整源对照和 API 35 验收也已完成；D2/D3 于 2026-07-13 按阶段门顺序完成实现与 API 35 验收，记录见[阶段 D2–D3 Android 验证](stage-d2-d3-android-validation.md)。

## 2. 当前基线与主要差距

### 2.1 可以直接复用的正式语义

- `formal-v1` migration 1 已包含用户词汇、来源、收藏语境、学习计划、计划成员、排除、FSRS 配置、复习卡、复习/强化事件、暂停/重置墓碑和设备本地 session 表。
- `src/shared/types.ts` 已定义 `LexemeKey`、词形候选、词典结果、生词状态、计划、队列、卡片、两阶段回答和幂等 `commandId` DTO。
- `src/core/lexicon` 已有稳定词元身份规则；`src/core/study` 已有 FSRS、队列、强化和学习日时钟等纯 TypeScript 规则。
- 便携 format v1 和 Sync Model v1 已覆盖上述不可再生逻辑数据；设备本地活动 session 与可再生词典资源明确不导出。
- 阶段 B 已提供 Android bundled SQLite、Keystore、固定 HTTPS 原生网络适配器、原子替换和私有目录；阶段 C 已提供阅读 token、窄 Tauri client、冷启动恢复及受控资源协议模式。

### 2.2 不能直接搬到 Android 的实现

- Windows 词典安装依赖 `node:fs`、`node:sqlite` 和 `worker_threads`，不能进入 `src/core` 或 Android renderer。
- Windows 词典查询 worker 直接打开本地 SQLite 路径；Android renderer 不得获得路径、任意 SQL 或任意文件读取能力。
- `SqliteStudyRepository` 同时包含 SQL 事务、UUID/摘要、队列编排和 FSRS 提交，需要拆出可共享规则并重新定义 Rust repository 边界。
- Windows 系统 TTS、DPAPI、Electron 网络栈和桌面抽屉交互不能作为 Android 实现前提。

### 2.3 数据契约判断

D0–D3 预期只使用现有 `formal-v1` 表，不新增 migration，不改变便携 format v1、Sync Model v1 或 `LexemeKey` 规则。

若发现现有结构无法表达 Android 所需语义，必须停止当前子阶段并单独评审：

1. 是否确属新的不可再生数据，而不是适配器实现问题；
2. 是否需要新增 migration 2；
3. 是否需要新增便携格式版本和 Sync Model 映射；
4. 升级、失败回滚、旧版恢复和跨平台兼容测试是否完整。

禁止修改 migration 1、增加 Android 私有用户表、复用缓存表存放用户数据，或在 renderer 本地存储绕过正式数据库。

## 3. 目标架构

```text
移动阅读/词典/学习 UI
        │
        ▼
MobileLearningClient（逻辑 DTO、无路径/SQL/密钥）
        │ Tauri commands/events
        ├───────────────┐
        ▼               ▼
Rust 用户数据仓储       Rust ECDICT 资源仓储
formal-v1 事务          只读版本化 SQLite
        │               │
        └──────┬────────┘
               ▼
共享纯 TS 规则 / 固定兼容向量
LexemeKey、词形裁决、FSRS、队列、学习时钟、事件语义
```

强制边界：

- renderer 只能按业务命令查询词典、收藏词汇和提交答案；不得传入 SQL、数据库路径、任意文件路径或任意 URL。
- ECDICT 是可再生资源，使用独立只读连接和版本 manifest，不参与用户数据库 migration。
- 所有用户数据变更在 Rust `formal-v1` repository 内事务提交，并维护现有 revision/墓碑语义。
- 普通查词必须保持只读；只有明确收藏、保存语境、计划操作或答题才写用户数据库。
- API 密钥仅通过阶段 B 的 Keystore 适配器读取；D0–D3 不新增在线供应商密钥 UI。
- 移动端可以使用专门的薄 UI 验证闭环；阶段 E 再统一完整导航、视觉和功能覆盖。

## 4. D0：契约、算法归属与资源 spike

### 4.1 目标

在写业务功能前冻结 D1–D3 的端口、兼容向量、资源包协议和事务所有权，消除 FSRS/队列双实现漂移风险。

### 4.2 交付

#### A. 依赖与契约清单

- 列出 D1–D3 实际使用的 `DictionaryApi`、`VocabularyApi`、`StudyApi` 最小方法集；新建组合式 `MobileLearningClient`，不复制完整桌面 API。
- 固定错误分类：资源未安装、资源不兼容、空间不足、查询取消、词形歧义、实体失效、版本冲突、重复命令和数据库暂不可用。
- 固定时间、UUID、`deviceId`、`commandId`、`expectedVersion` 和事件 ID 的产生位置。
- 区分用户数据、设备本地 session、可再生词典包、查询缓存和诊断数据。

#### B. 跨平台兼容向量

新增固定小型 ECDICT 测试包和逻辑 JSON 向量，但不提交真实 ECDICT：

- 精确词形、规则变形、多个候选和未命中；
- `LexemeKey`、候选顺序、置信度、简释与考试标签；
- 收藏、取消收藏、收藏语境和墓碑；
- “我的生词”来源同步及计划成员；
- 固定时钟下的学习日、队列顺序、FSRS before/after、scheduler profile 摘要；
- `commandId` 重放、错误 `expectedVersion`、认识/不认识强化和不可变事件。

向量必须由 Windows TypeScript/SQLite 和 Android Rust repository 同时消费。

#### C. FSRS 与队列归属 spike

比较并记录两个候选方案：

1. **共享 TypeScript 计算 + Rust 原子提交**：worker 使用 `src/core/study` 计算 transition，Rust 通过 card/session 版本、输入摘要和范围校验后原子写入。
2. **Rust 原生计算**：Rust 使用受审计实现，在同一 command 内计算并提交；以 TypeScript 向量逐字段验证结果。

选择标准：

- 与 `ts-fsrs 5.4.1`、FSRS-6 参数和日志字段逐项一致；
- 一次回答必须只有一个数据库提交点；
- 应用在计算前、计算后或提交后被终止都不会重复事件；
- 远期 iOS 不需复制第三套算法；
- 升级算法时能保留 scheduler profile 和历史可解释性。

D0 必须选定一个方案并写成 ADR；不得把选择推迟到 D3 编码中途。

#### D. ECDICT 包协议 spike

- 使用仓库内生成脚本制作小型 SQLite fixture；真实标准包和完整包继续位于仓库外。
- 定义 manifest：资源 schema、profile、dataset revision、条目数、文件大小、SHA-256、`lexemeMapHash` 和兼容的基础包 revision。
- Android 优先安装预构建 SQLite 包，不在手机上解析完整 CSV。
- spike 验证从 Android 系统选择器安装本地包、私有 staging 校验、空间预检、只读打开、原子替换、取消和旧包保留。
- `ecdict-full.sqlite` 只验证兼容协议；D1 正式功能只要求 standard-v1 基础包。

#### E. WebView 能力 spike

- 验证阶段 C 的 `.lookup-word` 点击、长按、滚动冲突、底部面板和返回键。
- 验证系统字体放大和窄屏下目标尺寸；任意短语选择不作为 D1 前置条件。
- 验证 WebView 系统 TTS 和音频播放能力，但只记录结论，不在 D0 接入正式朗读。

### 4.3 退出条件

- ADR 明确 FSRS/队列计算与事务归属。
- ECDICT 小型包、manifest 和 Windows/Android 兼容向量可重复生成和验证。
- `MobileLearningClient` 方法、DTO、错误与取消行为冻结。
- migration/备份/同步影响审计结论为“无变化”，或已独立启动新版本设计。
- 华为 API 31 与 API 35 完成资源安装和点词交互 spike；Electron 全量回归通过。

### 4.4 明确不做

- 不展示正式词典结果，不写用户词汇，不创建计划，不提交 FSRS 事件。
- 不接入百度、翻译、远程语音或正式设置 UI。

## 5. D1：离线 ECDICT、搜索与阅读器点词查词（实现与 API 35 验收完成；真机项转入阶段 D 集中清单）

### 5.1 目标

完成“联网预载或安装 standard-v1 → 搜索/在文章中点击单词 → 后台离线查询 → 处理词形歧义 → 重启后仍可查询”的只读闭环。

### 5.2 交付

#### A. 资源安装与生命周期

- Android 系统选择器可选择经过 manifest 描述的预构建基础包。
- 用户显式联网预载时，只允许固定 ECDICT commit 的官方 raw URL 与两项固定镜像；Kotlin 逐字节流入私有 staging，并同时校验精确大小和 Git blob SHA-1。Rust 再按 Windows standard-v1 规则流式生成 SQLite，不允许 renderer 传入 URL、路径或构建参数。
- 私有 staging 中校验大小、SHA-256、SQLite header、资源 schema、`quick_check`、metadata 和 `lexemeMapHash`。
- 安装前空间预检；同卷临时文件和原子替换；失败、取消和崩溃保留上一可用版本。
- 查询期间替换/删除先关闭只读仓储；启动清理受管 staging 和无 manifest 的半成品。
- 删除基础包只删除可再生资源，不修改用户词汇、语境、计划、卡片或事件。

#### B. Rust 只读查询仓储

- 使用独立 bundled SQLite 只读连接，不附加到 `reader.sqlite`，不暴露任意查询。
- 最小命令：状态、联网/本地安装、取消、删除、上下文查词、英文词元/词形与中文简释搜索、按 `LexemeKey` 取详情。
- 查询运行在后台任务；同一请求可取消；过期响应不能覆盖新点击结果。
- 输出复用现有逻辑 DTO，固定候选排序、词性别名、标签和简释归一化。

#### C. 薄移动 UI

- 提供受控的最小搜索页：只覆盖英文词元/词形前缀、中文简释 FTS、结果和词条详情，不提前迁移桌面完整词典中心。
- 点击英文 token 打开移动底部词典面板；再次点击切换请求。
- 显示 surface、lemma、音标、简释、候选选择、加载/未安装/未命中/错误状态。
- 面板关闭和 Android 返回键不改变阅读锚点。
- D1 中不显示收藏、文中义、百度结果、例句翻译、考试词集或高级筛选。

### 5.3 退出条件

- 飞行模式下可安装本地 fixture/标准包并在真实 EPUB 中连续查词。
- 精确词形、变形、多候选和未命中与 Windows 固定向量一致。
- 100 次连续点词无主线程明显卡顿、无跨请求串结果、无持续连接/内存增长。
- 强制结束、覆盖安装和冷启动后词典状态正确；失败替换仍可查询旧包。
- 普通查词前后 `reader.sqlite` 用户表和 revision 不发生变化。
- 完整验证过程与剩余华为门禁记录在[阶段 D1 Android 验证](stage-d1-android-validation.md)。

### 5.4 明确不做

- 不实现百度增强、文中义、英文定义/例句全文搜索、考试词集浏览、高级筛选和完整定义扩展 UI。
- 不写入生词或语境。

## 6. D2：生词与语境持久化

### 6.1 目标

在 D1 的稳定 `LexemeKey` 上完成“收藏词条/语境 → 生词列表 → 冷启动恢复 → 取消后不被旧状态复活”的用户数据闭环。

### 6.2 交付

#### A. Rust 用户词汇仓储

- 最小命令：读取当前词条状态、设置收藏、设置当前语境收藏、生词分页、语境分页、取消收藏。
- 每个写操作在 `reader.sqlite` 事务中维护用户词汇、来源、语境、revision、实体变化和取消墓碑。
- 使用现有稳定 ID、`updated_at + device_id` 和快照字段；不得依赖 ECDICT 文件长期保存显示所需原文。
- 同一逻辑命令重复执行幂等；文章/词典包删除后收藏语境仍可显示快照。

#### B. 词典面板与生词薄 UI

- D1 面板增加“收藏词条”和“收藏当前语境”两个明确操作；普通查词继续零写入。
- 新增最小“我的生词”列表、空状态、词条详情和已保存语境。
- 列表只覆盖 D3 所需入口；完整搜索、筛选、考试词集和批量操作后置到 E2。
- 返回阅读器时恢复原文章和阅读锚点。

#### C. 跨平台记录兼容

- 固定操作序列分别在 Windows/Android 执行，比较逻辑 DTO、稳定 ID、墓碑和 portable/sync 选择结果。
- D2 暂不实现 Android 便携导出，但现有 format v1 导出器必须能够表示 Android 所写记录。

### 6.3 退出条件

- 收藏词条、收藏语境、取消、再次收藏和重复提交均有事务/幂等测试。
- 强制结束、前后台切换、词典包删除和文章删除后状态符合正式契约。
- Windows 读取 Android 逻辑 fixture、Android 读取 Windows fixture，结果一致。
- D2 没有新增 migration 或便携格式；若发生变化，独立版本工作已先完成。

### 6.4 明确不做

- 不自动把普通查词加入生词，不实现批量导入、手工熟练度编辑或完整词典中心。
- 不创建学习计划或卡片。

## 7. D3：最小计划、每日队列与一张 FSRS 卡

### 7.1 目标

完成“我的生词 → 最小学习计划 → 打开今日学习 → 两阶段回答一张卡 → 原子写入 FSRS/强化事件 → 冷启动恢复”的离线学习闭环。

### 7.2 交付

#### A. 计划与来源

- 只支持一个最小计划创建流程，来源固定为现有 `reader_manual` / “我的生词”；使用正式计划和来源表，不建立 Android 特例。
- 可设置每日新词/复习上限；计划暂停、归档、考试词集、逐词排除和高级诊断后置到 E2。
- 来源同步使用现有 origin/membership 语义，收藏变化可幂等更新计划成员。

#### B. 学习 session 与队列

- 固定学习日 cutoff、时区、跨日结转、new/review/carryover 和稳定队列顺序。
- `openToday`、读取当前卡和两阶段回答由窄命令提供；完整列表/总结只返回最小字段。
- 活动 session 是设备本地临时状态，不进入便携备份或未来跨设备同步。

#### C. 原子回答事务

- `stageAnswer` 使用 `expectedVersion` 将 pending 改为 revealed，不产生 FSRS 事件。
- `commitAnswer` 在一个事务中校验 current item、version、proposed answer 和 `commandId`，更新卡片、scheduler profile、复习/强化事件、队列位置和 session 状态。
- 相同 `commandId` 重放返回已有 session 状态，不重复卡片更新或事件。
- 在开始事务前、事务中、提交后和响应返回前模拟终止，验证至多一次语义。
- “不认识后连续认识两次”的强化规则和第一次 FSRS 提交与 Windows 固定向量一致。

#### D. 薄移动复习 UI

- 最小计划创建页、今日入口和单卡页面。
- 第一阶段选择“认识/不认识”，第二阶段展示答案并确认；禁用重复点击，冲突时刷新当前卡。
- 前后台、旋转和 Android 返回键不隐式提交；冷启动恢复 pending/revealed 状态。
- 发音、远程例句、完整总结、历史筛选、D/S/R 图表和“太简单”后置到 E2。

### 7.3 退出条件

- 同一固定时钟、词汇集合和回答序列在 Windows/Android 生成一致的队列、card before/after、profile、事件语义和下一到期时间。
- 重复点击、超时重试、错误版本、应用强制结束和跨日结转不会重复记忆事件。
- 完全离线时可完成一张新卡和一张到期复习卡；重启后状态保留。
- D0–D3 全链路在华为 API 31 和 API 35 通过，Electron 类型检查、全量测试和 NSIS 打包不回退。

### 7.4 阶段 D 总退出条件

只有同时满足以下条件，路线图才可标记阶段 D 完成：

- Android 可离线完成点词、查词、收藏、生词列表、最小计划和一张复习卡。
- 所有用户数据只进入正式 `formal-v1` 表，普通查词零写入。
- Windows/Android 兼容向量覆盖词典、词汇、来源、计划、队列、卡片和事件。
- 词典资源失败不损坏用户数据，学习事务失败不产生半张卡或半个事件。
- 在线供应商和完整移动 UI 明确仍为后续范围，没有用占位返回伪装为完成。

## 8. 测试矩阵

### 8.1 自动化与契约测试

| 编号 | 阶段 | 层级 | 场景 | 预期结果 | 执行位置 |
| --- | --- | --- | --- | --- | --- |
| D-001 | D0 | Core | 固定 lemma 生成 `LexemeKey` | Windows/Android 字节级一致 | TS + Rust 向量 |
| D-002 | D0 | Core | 精确/变形/多候选排序 | 候选、关系、置信度一致 | TS + Rust 向量 |
| D-003 | D0 | Core | 固定时钟 FSRS 回答序列 | before/after/log/profile 摘要一致 | TS + Rust 向量 |
| D-004 | D0 | Core | 队列种子、学习日和强化序列 | 顺序和状态转换一致 | TS + Rust 向量 |
| D-005 | D0 | Boundary | renderer 源码扫描 | 无 SQL、FS、任意 URL、原生插件直连 | Vitest |
| D-006 | D0 | Data | migration/backup/sync 影响审计 | 正式版本未被原地修改 | 契约测试 |
| D-101 | D1 | Resource | 有效小型基础包安装 | 校验后原子发布并可查询 | Rust 测试 |
| D-102 | D1 | Resource | SHA/schema/revision/hash 不匹配 | 明确拒绝，旧包保留 | Rust 测试 |
| D-103 | D1 | Resource | 安装中取消/空间不足/进程终止 | 无半成品，旧包可用 | Rust + 设备 |
| D-104 | D1 | Query | 精确词、变形、多候选、未命中 | 与向量一致，错误脱敏 | Rust 集成测试 |
| D-105 | D1 | Query | 快速连续 100 次请求及取消 | 旧响应不覆盖新结果 | 客户端测试 + 设备 |
| D-106 | D1 | Data | 普通查词前后数据库比较 | 用户表、revision 零变化 | Rust 集成测试 |
| D-107 | D1 | Lifecycle | 替换/删除词典时存在查询 | 有序关闭，无锁死或损坏 | Rust 集成测试 |
| D-108 | D1 | Supply chain | 固定源下载、大小/blob SHA 与镜像回退 | 非白名单或内容漂移均拒绝发布 | Kotlin 构建 + 设备 |
| D-109 | D1 | Search | 英文词元/词形与中文简释搜索 | 排序、匹配类型和详情与 Windows 语义一致 | Rust + 设备 |
| D-201 | D2 | Data | 收藏词条/语境 | 正式表、revision、变化索引同事务更新 | Rust 集成测试 |
| D-202 | D2 | Data | 重复收藏、取消和再次收藏 | 幂等且墓碑时间语义正确 | Rust 集成测试 |
| D-203 | D2 | Data | 文章或词典包删除 | 快照仍可显示 | Rust 集成测试 |
| D-204 | D2 | Compatibility | Windows/Android 固定操作序列 | DTO、ID、墓碑、portable/sync 选择一致 | TS + Rust 向量 |
| D-205 | D2 | UI | 面板到生词列表再返回 | 阅读文章和锚点保持 | Vitest + 设备 |
| D-301 | D3 | Plan | “我的生词”来源初次/重复同步 | 成员无重复，删除/恢复正确 | TS + Rust 向量 |
| D-302 | D3 | Queue | 固定时间建立今日 session | new/review/carryover 和顺序一致 | TS + Rust 向量 |
| D-303 | D3 | Answer | 两阶段认识/不认识 | stage 不提交 FSRS；commit 原子提交 | Rust 集成测试 |
| D-304 | D3 | Idempotency | 相同 `commandId` 重放 | 卡片和事件只写一次 | Rust 集成测试 |
| D-305 | D3 | Concurrency | 错误 `expectedVersion`/双击 | 冲突返回并刷新，不写半状态 | Rust + 客户端测试 |
| D-306 | D3 | Recovery | 事务故障注入和四个终止点 | 回滚或已完整提交 | Rust 故障注入 |
| D-307 | D3 | Clock | cutoff、时区、跨日结转 | 与 Windows 逻辑一致 | TS + Rust 向量 |
| D-308 | D3 | Sync safety | reset/暂停/旧事件选择 | 旧状态不会复活 | 现有 sync/portable 回归 |

### 8.2 阶段 D 模拟器与集中真机矩阵

| 场景 | 华为 API 31 ARM64 | API 35 x86_64 | 通过标准 |
| --- | --- | --- | --- |
| 固定源联网预载与完整索引 | 已通过 | 已通过 | 大小/blob SHA、计数、映射摘要和 staging 清理正确 |
| 本地基础包安装/取消/替换 | 联网预载/删除/重装通过 | 必测 | 无半成品，旧包保留 |
| 飞行模式点词查词 | 发布候选专用设备补测 | 必测 | 无网络仍可查 |
| 100 次连续点词与滚动 | 已通过 | 补测 | 无明显 UI 卡顿、串结果或崩溃 |
| 多候选选择和返回键 | 已通过 | 已通过 | 锚点不漂移，状态清晰 |
| 收藏、取消、冷启动 | 已通过 | 已通过 | 状态和墓碑正确 |
| 创建最小计划并完成一张卡 | 已通过 | 已通过 | 卡片/事件完整且只写一次 |
| 回答时 Home/旋转/强制结束 | 核心路径通过 | 已通过 | 不隐式提交，可恢复 |
| 系统字体 1.0/1.3/1.5 与横屏 | 已通过 | 已通过 | 主要操作可见且触摸目标可用 |
| 低存储与词典资源删除 | 资源删除通过；低存储后置 F1 | 补测 | 用户数据库不受影响 |
| 覆盖安装 | 已通过 | 已通过 | 资源、词汇和学习状态保留 |

### 8.3 分层回归

每个子阶段日常与退出前执行：

- `pnpm typecheck`
- `pnpm test`
- `cargo fmt --check`
- `cargo test`
- `cargo clippy --all-targets -- -D warnings`
- 对应 ARM64/x86_64 Android target 构建
- API 35 模拟器的功能、生命周期和 UI 回归
- `pnpm dist` Windows NSIS
- `git diff --check`、真实 ECDICT/数据库/密钥/日志/构建产物审计

阶段 D 结束时再集中执行：

- 华为 API 31 ARM64 上的 D1–D3 真机矩阵
- Huawei WebView、真实触摸/滚动、文件选择器、字体/横屏、前后台回收和真实性能检查
- 覆盖安装后词典、书库、生词、语境、计划、卡片和事件的联合持久化回归

## 9. 风险登记与停止条件

| 风险 | 影响 | 控制措施 | 停止条件 |
| --- | --- | --- | --- |
| FSRS 双实现漂移 | 跨平台卡片状态不同 | D0 ADR、逐字段向量、固定版本/profile | 无法逐字段一致时不进入 D3 |
| 回答跨多次 command | 重复或半个事件 | 单一提交点、`commandId`、`expectedVersion`、故障注入 | 无法证明至多一次时不开放 UI |
| ECDICT 包过大或替换失败 | 存储耗尽、词典不可用 | 预构建包、空间预检、旧包保留、原子替换 | 无安全替换路径时不支持正式包 |
| 普通查词误写用户数据 | 隐私和学习数据污染 | D1 数据库前后比较 | 任意只读路径产生 revision 即阻断 |
| 在线供应商组合爆炸 | 阶段不可收敛 | D 中全部后置，仅保留能力 spike | 在线服务进入 D 关键路径即回退范围 |
| 移动 UI 过早追求完整 | 数据正确性被视觉工作掩盖 | D 使用薄 UI，E 再统一覆盖 | D 出现完整设置/词典中心需求即后置 |
| 新数据无法由 format v1 表达 | Android 数据不可恢复 | 开工前影响审计 | 必须先设计 migration/format 新版本 |
| 前后台与旋转竞态 | 重复回答、状态丢失 | 可恢复状态机、禁隐式提交、设备矩阵 | 复现数据重复时阻断子阶段退出 |

## 10. 建议提交与分支顺序

每个子阶段从最近已验收提交建立短期分支，不建立长期 Android 分支：

### D0

1. `docs: freeze Android learning boundaries`
2. `test: add lexicon and study compatibility vectors`
3. `refactor: isolate portable learning rules`（仅在 ADR 需要时）
4. `docs: record D0 architecture decision`

### D1

1. `feat(android): add verified dictionary pack lifecycle`
2. `feat(android): add read-only ECDICT repository`
3. `feat(android): add mobile word lookup slice`
4. `docs: record D1 device validation`

### D2

1. `feat(android): add vocabulary transaction repository`
2. `feat(android): add vocabulary client and thin UI`
3. `test: add cross-platform vocabulary vectors`
4. `docs: record D2 device validation`

### D3

1. `feat(android): add minimal plan and source repository`
2. `feat(android): add idempotent study session transactions`
3. `feat(android): add single-card review UI`
4. `test: add FSRS and recovery vectors`
5. `docs: record stage D validation`

## 11. 阶段 D 之后的路线

### 阶段 E：移动 UI 与功能覆盖

阶段 E 继续拆为可独立验收批次：

- **E0：产品壳、设计系统与对照账本**——四项底部导航/宽屏 navigation rail、独立 tab 栈、安全区、统一状态和正式令牌。
- **E1：我的书库与本地阅读**——分类、排序、选择/批量、重命名/删除、目录、文章搜索、阅读外观和锚点。
- **E2：词典与我的生词**——双模式、考试词集、高级筛选、完整详情、语境深链和 standard/full 资源。
- **E3：背单词**——今日 dashboard、完整答题状态、历史、计划管理、来源同步、熟练度与 D/S/R。
- **E4：设置与在线服务**——翻译、百度增强、系统/远程语音、学习参数、资源/存储和开发诊断。
- **E5：跨模块收口**——深链、状态快照、生命周期、无障碍、性能和完整 Windows/Android 覆盖审计。

详细功能账本、移动交互映射和退出门禁见[阶段 E Android 完整产品 UI 与 Windows 功能对齐计划](stage-e-mobile-parity-plan.md)。

阶段 E 的退出条件是日常功能覆盖和长期可用性，不再重新定义 D 已冻结的数据语义。

### 阶段 F：备份、升级与 Android Beta

- **F0：便携备份互通**——Android format v1 导出、预览、校验、幂等导入及 Windows/Android 双向恢复。
- **F1：升级和发布加固**——覆盖升级、未知高版本、低存储、崩溃恢复、release keystore、版本码、离线长期使用和发布候选回归。

只有 F0/F1 完成后进入 Android Beta；局域网同步仍保持阶段 G，不因阶段 D 产生的学习数据而提前。

## 12. 下一步

D1–D3 的实现、兼容向量、自动测试、双 ABI 构建、API 35 和华为 API 31 核心真机验收已完成，阶段 D 可结束。下一步进入 E0 的移动产品壳、导航与功能覆盖对照；飞行模式、低存储、删除保留刊物和手工跨日等破坏性设备项目继续留在集中清单，待专用设备或发布候选批次执行。
