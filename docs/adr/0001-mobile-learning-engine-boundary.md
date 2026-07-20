# ADR-0001：移动学习计算与持久化边界

> 状态：已接受
> 日期：2026-07-12
> 适用阶段：D0–D3

## 背景

Windows 当前使用 `ts-fsrs 5.4.1`、`src/core/study` 的纯 TypeScript 规则和 `SqliteStudyRepository` 的 Node SQLite 事务。Android 用户数据库由 Rust `rusqlite` 管理，renderer 不得访问 SQL、文件路径或 Node API。

D3 必须同时满足：

- Windows/Android 的 FSRS-6、队列、强化和学习日语义一致；
- 一次回答只有一个原子数据库提交点；
- `commandId` 重放、`expectedVersion` 冲突和应用终止不会产生重复事件；
- 远期 iOS 不维护第三套学习算法；
- scheduler profile 能准确记录算法和参数版本。

## 候选方案

### 方案 A：共享 TypeScript 计算，Rust 校验并原子提交

纯 TypeScript 根据明确的 card/session 快照生成版本化 proposal。Rust 校验 contract/engine 版本、`commandId`、`expectedVersion`、输入 card 指纹、参数指纹、字段范围和队列集合，再在单一事务中写 card、profile、事件、队列和 session。

优点：

- 继续以现有 `ts-fsrs 5.4.1` 为唯一计算实现；
- Windows、Android 和远期 iOS 直接复用同一算法与向量；
- 算法升级只增加 engine/profile 版本，不需同步升级 Rust 数值实现。

代价：

- 计算与提交是两个步骤；提交前必须重新验证输入快照，不能信任过期 proposal；
- Rust 只能验证 proposal 的来源状态、结构和不变量，不能独立证明每个浮点输出由 FSRS 计算得出。

### 方案 B：Rust 原生计算并提交

Rust command 读取当前状态、执行 FSRS/队列算法并在同一事务提交。

优点：单一 command 和最强的原生完整性边界。

代价：

- 需要维护与 `ts-fsrs 5.4.1` 逐字段一致的第二套实现，包括浮点、日期对齐和日志；
- Windows 仍使用 TypeScript，算法升级必须双端同步；
- iOS 虽可复用 Rust，但 Electron/Rust 漂移风险持续存在。

## 决策

采用**方案 A：共享 TypeScript 计算，Rust 校验并原子提交**。

理由：本项目是本地个人应用，renderer 不是远程不可信客户端；跨平台长期一致性和算法可升级性比在 Rust 中复制 FSRS 更重要。数据完整性通过版本化 proposal、输入指纹、命令幂等和 Rust 单点事务保证。

## 协议

### Review transition

`MobileReviewTransitionProposal` 固定包含：

- `contractVersion=1`
- `engineVersion=fsrs-6/ts-fsrs-5.4.1/mobile-v1`
- `commandId`、`expectedVersion`、answer、reviewedAt
- before card 及按 IEEE-754 位模式计算的 `beforeFingerprint`
- 规范 JSON 参数摘要 `parametersFingerprint`
- after card、rating 和版本化 log

Rust D3 提交前必须重新读取 current item/card，并拒绝：

- 版本、命令、before card 或指纹不匹配；
- engine/contract 未知；
- 非有限值、越界 state、负计数或非法时间；
- answer/rating 不一致；
- 已有相同 `commandId` 但语义不同。

相同 `commandId` 已成功提交时返回现有 session 状态，不再次计算或写事件。

### Queue plan

`MobileQueuePlanProposal` 固定输入 seed、order、review/new key 列表、输入摘要和最终顺序。Rust 验证输入无重复、输出是输入的严格排列、摘要和 session/version 匹配，再在创建 session 的事务中持久化。

### 终止语义

- 计算前或计算后、提交前终止：数据库无变化；下次重新读取并计算。
- Rust 事务中终止/失败：SQLite 回滚。
- 事务提交后、响应前终止：同一 `commandId` 重放返回已提交状态。

## 安全与边界

- proposal 不包含 SQL、路径、密钥或任意 URL。
- Rust 不接受 renderer 提供的 device ID、事件 ID、数据库时间戳或 scheduler profile ID；这些在原生事务内产生。
- 正式 release 只开放 D1–D3 业务 command；D0 工程探针由 Rust `debug_assertions` 门控。
- 普通查词与 proposal 计算不写数据库。

## 兼容与版本影响

- 不修改 `formal-v1` migration 1。
- 不修改便携 format v1 或 Sync Model v1。
- 不修改 `LexemeKey` 或内容 ID v2。
- engine 或 proposal 字段变化必须增加新版本，并保留旧 scheduler profile/事件的读取和解释能力。

## 验证

- `test-vectors/d0-learning.json` 固定词元、FSRS transition、参数/card 指纹、队列和强化状态。
- TypeScript 生成向量；Rust 逐字段反序列化、验证输入摘要和不变量，并拒绝篡改 proposal。
- D3 增加事务重放、版本冲突和四个终止点故障注入后，本 ADR 才视为完整落地。
