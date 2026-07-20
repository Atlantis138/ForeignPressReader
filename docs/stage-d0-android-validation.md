# 阶段 D0 Android 验证记录

> 状态：已完成
> 日期：2026-07-12
> 分支：`feature/android-learning-foundation`
> 前置基线：阶段 C 验收提交 `bae8099`

## 1. 结论

D0 的契约、算法归属、兼容向量、ECDICT 包协议和 WebView 能力 spike 已通过。下一步可以单独规划 D1“离线 ECDICT 与阅读器点词查词”，但本阶段没有实现正式词典查询、用户词汇写入、计划、FSRS 事件、在线服务或正式移动 UI。

本阶段没有修改 `formal-v1` migration 1、便携备份 format v1、Sync Model v1 或内容 ID v2，也没有提交真实 ECDICT、EPUB、用户数据库、密钥、日志或构建产物。

## 2. 架构与契约结果

- `MobileLearningClient` 只组合 D1–D3 所需的词典、词汇与学习最小能力；DTO 不含路径、SQL、任意 URL 或原生插件句柄。
- 错误分类固定为资源缺失/不兼容/空间不足、查询或安装取消、词形歧义、实体失效、版本冲突、重复命令和数据库暂不可用等逻辑错误。
- 时间、`deviceId`、`commandId`、`expectedVersion`、事件 ID 与版本校验的产生/消费位置已冻结；可再生词典包与用户不可再生学习数据保持分离。
- ADR `0001-mobile-learning-engine-boundary.md` 选择“共享 TypeScript 计算 + Rust 原子提交”：TypeScript 以固定时钟和 profile 生成完整 transition proposal；Rust 校验 command/card/参数/输入输出摘要及版本，并在 D3 的单一事务点至多提交一次。
- 该方案继续以 `ts-fsrs 5.4.1` / FSRS-6 为唯一调度实现，Android 与远期 iOS 不增加第二套算法。

## 3. 词典资源包 spike

仓库脚本 `scripts/build-d0-dictionary-fixture.mjs` 可重复生成被 `.gitignore` 排除的外部测试产物 `test-artifacts/d0-dictionary/d0-standard-v1.fprdict`。fixture 含 3 个词元、4 个词形，SQLite 为 73,728 字节；本次 manifest 摘要为：

| 字段 | 值 |
| --- | --- |
| `formatVersion` | `1` |
| `resourceSchemaVersion` | `4` |
| `profile` | `standard-v1` |
| `datasetRevision` | `d0-fixture-2026-07-12` |
| `sha256` | `59de239cd3ea1a9daa6288a103e3561c47eefa223d17cb0b3e7cddd6f519a620` |
| `lexemeMapHash` | `f0dc9464431b91d6a9250f829c9acfe218947cd671fc6aff4fde57e3ba8a5cd5` |

Android 系统选择器只把所选包复制到应用私有 `.staging/dictionary-packs/<requestId>`。Rust 限制 512 MiB 包大小与固定两项 ZIP 清单，校验 manifest、SHA-256、可用空间、SQLite `quick_check`、metadata、条目/词形计数和词元映射摘要后，才在 `dictionaries/ecdict-base` 原子发布。安装失败或发布前故障保留旧 generation；取消和启动恢复会清理 staging。

## 4. 自动测试矩阵

| 范围 | 场景 | 结果 |
| --- | --- | --- |
| TypeScript/Rust 向量 | `LexemeKey`、精确/变形/多候选、FSRS proposal、profile、队列顺序与摘要 | 逐字段一致 |
| Rust proposal 校验 | 篡改输入/输出、参数摘要、card fingerprint、版本和命令字段 | 拒绝 |
| 资源安装 | 有效包校验、只读打开和原子发布 | 通过 |
| 资源失败 | 错误 SHA 替换、发布前故障 | 旧包保持可用 |
| Renderer 边界 | 无 SQL、FS、HTTP、任意路径和直接原生调用 | 通过 |
| Tauri client | 四个 D0 debug command 映射与结构化错误 | 通过 |
| 正式契约审计 | migration 1、portable v1、Sync v1、内容 ID v2 | 无变化 |

最终自动回归：

- `pnpm typecheck`：通过。
- `pnpm test`：24 个测试文件，111 项通过、2 项跳过。
- `cargo test`：30 项通过。
- `cargo fmt --check`：通过。
- `cargo clippy --all-targets -- -D warnings`：通过。
- ARM64 与 x86_64 Android debug APK：构建通过。
- `pnpm dist`：Windows x64 NSIS 构建通过。首次与被外层超时残留的并发打包重叠时出现 `electron.exe` rename 竞争；清理为单一打包进程后独立重跑通过，判定为验证命令竞争而非代码故障。

## 5. 设备测试矩阵

| 场景 | Huawei OCE-AL50 / API 31 / ARM64 | API 35 AVD / x86_64 |
| --- | --- | --- |
| 安装小型 `.fprdict` | 3 词元/4 词形，成功 | 3 词元/4 词形，成功 |
| 系统选择器取消 | 旧包状态不变 | 自动/Rust 覆盖，设备安装路径通过 |
| 冷启动资源保留 | 通过 | 通过 |
| staging 清理 | 安装后无请求目录 | 安装后无请求目录 |
| token 点击/长按 | 面板显示 surface、tokenIndex 和手势 | 通过 |
| token 区滚动 | 410px 内容在 224px 容器内滚动，手势无冲突 | 通过 |
| Android 返回键 | 关闭底部面板，不退出阅读探针 | 通过 |
| 系统字体 1.5 倍 | 不修改个人真机全局设置 | 标题 32→48px，token 18.88→28.32px，按钮 55.70px |
| 窄屏/横屏 | 393 CSS px 竖屏通过 | 393px 竖屏；851×393 横屏无横向溢出 |
| 系统 TTS | 可用，英文可用，4 种语言 | 可用，英文可用，68 种语言 |
| Web 音频 | 短音频播放成功 | 短音频播放成功 |

API 35 的 `font_scale` 已从测试值 `1.5` 恢复为 `1.0`，旋转锁已恢复为自由旋转。D0 探针仅在 debug 构建通过 `tauri.html?d0=1` 使用；release command 会返回 `probeUnavailable`，正式入口仍是阶段 C 移动书库。

## 6. D1 进入条件与边界

D1 可以复用本阶段冻结的资源 manifest、兼容向量和 client/error 边界。D1 的最小目标是“安装 standard-v1 基础包 → Rust 后台只读查询 → 阅读 token 打开薄结果面板 → 普通查词零写入”。

D1 不得顺带实现收藏生词、语境、计划、FSRS 提交、百度词典、在线翻译、远程语音、完整词典中心或正式移动视觉；这些分别属于 D2、D3 或阶段 E。
