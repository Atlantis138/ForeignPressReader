# 阶段 E4 Android 验证记录

日期：2026-07-13
分支：`codex/android-offline-dictionary`
起点：`52fbc31 feat(android): complete stage E2 E3 mobile parity`
状态：E4 主要实现、本机自动化、双 ABI、Windows 分发、真实供应商脱敏冒烟、API 35 设置/系统 TTS 基础冒烟及第二轮移动视觉矩阵通过；完整设备、生命周期与华为真机门禁尚未关闭，不能标记为阶段完成。

## 1. 实现范围

### 设置、密钥与网络边界

- 冻结 `MobileOnlineServices v1`，移动 renderer 只使用版本化逻辑客户端；不暴露任意 URL、私有路径、SQL、文件系统或 Kotlin 插件能力。
- Android Keystore 按供应商保存翻译和远程 TTS 密钥；百度 API Key/Secret Key 作为原子凭据包替换或删除。IPC 只返回统一 `configured + masked` 状态，不返回原值。
- Kotlin HTTPS 端口只接受固定服务 allowlist、GET/POST、受控请求头/正文、超时、取消和响应大小；沿用 Android 系统代理/VPN，映射为不含上游正文的稳定错误分类。
- CSP 不开放公网 `connect-src`；受控诊断分享仅允许应用私有 `diagnostics/` 子目录。

### 翻译与阅读器

- 设置页接通 DeepSeek、OpenAI、Kimi 供应商、模型、密钥保存/替换/删除、连接测试和精确选择持久化。
- 阅读器接通分批文章翻译、进度、取消、失败反馈、缓存译文展开/收起与中文搜索；工具栏只保留一个全文翻译入口，段落只保留紧凑译文开关。缓存键绑定实际供应商、模型、提示词版本和源文本摘要。
- Kimi Moonshot V1 8K 使用收紧的输入/输出预算；上游以 `finish_reason=length` 截断或批次超限时自适应拆分，避免整篇翻译因单批过大失败。
- Windows 同步修复：词典“分析文中义”不再要求词已存在于 ECDICT 或先选择词性；当前点击词形和原句即可请求，结果记录实际解析依据与可选解析词元。

### 词典与学习例句

- 接通百度鉴权、按需查询、30 天 TTL、64 MiB LRU、本地 ECDICT 回退、中文释义/音标/词形/例句合并；考试标签与词频继续只来自 ECDICT。
- AI 文中义使用当前翻译服务，可只基于原词和语境生成；有候选词元时仍记录实际解析结果，不再以“词在表中/已选词性”为调用门槛。
- 例句译文使用当前翻译服务并按模型隔离缓存；学习卡揭示后可按需补齐百度/本地例句与中文译文，在线失败不阻塞答题或 FSRS 提交。

### 系统与远程语音

- Android 系统 TTS 能力探测、英文地区、播放完成/失败、停止和应用生命周期已接入；系统语音只在设备本机合成。
- Google Standard 与 MiniMax 中国站使用受控原生网络端口；远程音频按供应商/模型/声音/地区/语速/文本摘要隔离，原子写入并共享 256 MiB LRU 上限。
- 设置支持单词/文章独立供应商、模型/音色/语速/自动发音与两类试听；词典详情、阅读器薄面板和学习卡使用同一语音客户端。
- 阅读器从首个可见文本段落开始连续朗读，提供按原文段落上一段/下一段、暂停继续和停止；正文不重复放置逐段朗读按钮，长段落内部切片不会被当作下一段，当前段自动滚动到视区。

### 第二轮移动 UI 收敛

- 手机书库改为三列紧凑封面，更多操作改为 30 dp 圆形浮层；主按钮移除深色红色发光阴影，底栏和通用按钮/卡片/分段控件统一收窄。
- 修复 Huawei WebView 114 将受控资源映射到 `http://reader-asset.localhost` 后被 CSP 拦截的问题；CSP 仅增加这一固定图片源，renderer 仍不获得任意网络能力，封面失败时保留刊名字首占位。
- 设置根页合并为一个六项列表；standard/full 资源管理移入词典设置，百度回退、例句翻译和凭据只在“百度增强”时出现，原生 checkbox 改为一致的移动开关。
- 计划详情采用与 Windows 一致的说明、来源/配额摘要、熟练度环图/图例、编辑/暂停/归档和常驻筛选；视觉 fixture 新增计划详情场景。

### 数据、诊断与开发工具

- 设置显示正式数据、资源、安全缓存、AI 缓存与日志占用；安全缓存/AI 缓存/诊断日志可分别清理，私有路径不返回 renderer。
- 诊断日志默认关闭、字段脱敏和轮转；分享包使用固定格式和受限 FileProvider，日志清理只删除受管 `app-*` 普通文件。
- 隐藏开发入口接通 Rust 后端门控的计划删除/可选逐词进度重置、全量学习进度重置、模拟下一学习日和恢复出厂；确认名称/令牌和事务回滚均有测试。
- Android 便携备份仍诚实显示“阶段 F 提供”，没有假导入、导出或恢复成功按钮。

## 2. 自动化与构建门禁

| 门禁 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 35 个测试文件；174 项通过，2 项按设计跳过 |
| `pnpm ui:mobile:capture` 等价脚本 | 90 个截图组合；360/412/600/840 dp、横屏、浅深主题、1.0/1.3/1.5 字体及新增计划详情均无横向溢出或低于场景基线的触控目标 |
| `cargo fmt --all -- --check` | 通过 |
| `cargo test --locked` | 65 项通过，1 项需仓库外固定 ECDICT 源而忽略，0 失败 |
| `cargo clippy --locked --all-targets -- -D warnings` | 通过，零警告 |
| `:app:compileUniversalDebugKotlin` | 通过 |
| Android aarch64 split debug APK | 通过，296,026,898 bytes |
| Android x86_64 split debug APK | 通过，309,225,743 bytes |
| `pnpm tauri android build --target aarch64 --debug`（本轮 UI 修正版） | 通过，生成 313,510,866 bytes debug APK；已在华为 OCE-AL50 覆盖安装 |
| `pnpm dist` | 通过，Windows x64 NSIS 生成成功 |
| `git diff --check` | 通过；文档更新后最终交付前再次复核 |

新增回归覆盖：受限在线服务契约、密钥包原子保存/回滚/删除、Kimi 8K 预算/截断拆分、精确模型缓存、无词条文中义、百度回退/缓存、语音偏好与请求校验、学习例句补齐、开发工具门控/事务、受管日志清理、CSP 与 FileProvider 边界。

## 3. 真实供应商脱敏冒烟

测试凭据来自用户明确提供的仓库外文本文件。脚本只在内存读取，命令与输出只包含服务名、结果分类、`finish_reason` 或音频字节数；没有打印密钥、响应正文、Access Token 或请求 URL 查询参数，也没有写入仓库、应用数据库、日志、快照、APK 或 NSIS。

| 服务 | 与产品一致的测试 | 结果 |
| --- | --- | --- |
| Kimi Moonshot V1 8K | Chat Completions、JSON object、`max_tokens` | 有效 JSON，`finish_reason=stop` |
| DeepSeek V4 Flash | Chat Completions、关闭 thinking、JSON object | 有效 JSON，`finish_reason=stop` |
| OpenAI GPT-5.4 nano | Chat Completions、`max_completion_tokens`、JSON object | 有效 JSON，`finish_reason=stop` |
| Google Standard TTS | `en-US-Standard-C`、MP3 | 有效音频，6,336 bytes |
| MiniMax Speech 2.8 Turbo | `English_expressive_narrator`、MP3 hex | 有效音频，13,812 bytes |
| 百度词典 | OAuth client credentials + `dictionary` 英中词典查询 | 鉴权成功并返回词典数据 |

百度首次外部脚本尝试因测试文件同一行在 API Key 后包含中文分号和 `Secret-Key` 标签，脚本把标签误并入 API Key 而收到鉴权失败；按脱敏标签结构修正内存解析后立即成功。产品实现不解析该测试文件，设置页接收两个独立输入并以结构化原子凭据保存，因此不构成产品缺陷。

## 4. API 35 模拟器证据

设备：API 35、x86_64、Android WebView 124。使用本轮 x86_64 split debug APK `adb install -r` 覆盖安装，保留已有应用数据。

- 正式 Activity 冷启动成功：`Status: ok`，`LaunchState: COLD`，`TotalTime: 11775 ms`；进程启动后保持存活。首次尝试按 debug applicationId 推导 `.MainActivity` 得到 Activity 不存在，随后使用 `cmd package resolve-activity` 返回的 `com.local.foreignpressreader.MainActivity` 完成启动；这只是 ADB 测试命令修正，不是应用启动失败。
- 词典主页显示已安装 standard-v1（59,119 词元、67,810 词形），底部四模块和移动密度正常。
- 设置根页正确呈现阅读外观、翻译、词典、语音、每日学习和数据与存储；语音页在 945×2048 截图下无横向溢出，系统/Google/MiniMax 状态与移动卡片布局正常。
- 系统英文 TTS 能力被识别，使用默认 `en-US`、0.9× 点击“试听单词”后原生命令完成，界面恢复可操作并显示“单词试听完成”。

本轮没有把真实凭据写入模拟器 Keystore，也没有使用真实 EPUB 完成应用内全文翻译/远程朗读。因此 API 成功只能证明当前请求格式和凭据有效，API 35 系统 TTS 冒烟只能证明本机原生链路；不能替代第 6 节的完整设备矩阵。

## 5. 华为初步证据与本轮反馈闭环

- 第二轮 UI 修改前，E4 ARM64 debug APK 已在 Huawei OCE-AL50 / API 31 / Huawei WebView 114 使用 `adb install -r` 覆盖安装；安装前后 `reader.sqlite` 与 ECDICT 文件摘要不变，应用首安装时间不变，冷启动约 837 ms 且进程保持存活。
- 用户随后在真实书库、词典、计划、设置与带缓存译文的文章上完成手工走查，并据真机截图提出本轮密度、封面、资源入口、计划对齐、设置分组/开关和阅读器控件问题；这些反馈已进入 90 场景视觉 fixture 与源码回归。
- 第二轮 UI 修正版随后已在同一 Huawei OCE-AL50 使用 `adb install -r` 覆盖安装；`reader.sqlite`、ECDICT 摘要与首安装时间均保持不变，正式 Activity 冷启动 `TotalTime: 1014 ms`，进程持续存活且无致命日志。简单走查确认真实封面与正文图片加载、词典资源入口位于设置、原生开关样式正常、文章可进入正文且阅读器顶部为单一搜索/翻译/朗读/外观入口；完整深色、百度、计划与在线服务矩阵仍保留在集中门禁。

## 6. 尚未关闭的设备门禁

- API 35：应用内逐供应商保存/替换/删除/错误密钥与冷启动 masked 状态；真实测试 EPUB 的全文翻译进度/取消/重试、百度回退、无词条文中义、例句翻译、远程连续朗读与离线缓存复用。
- 生命周期：断网、超时、取消、Home/锁屏、前后台、进程回收、音频焦点、来电、耳机/蓝牙切换和缓存清理期间，本地阅读/查词/复习必须保持可用。
- UI/无障碍：360–840+ dp、浅深主题、字体 1.0/1.3/1.5、横竖屏、软键盘、TalkBack、reduced motion 和危险确认文案。
- 华为 OCE-AL50 / API 31 / Huawei WebView 114：继续完成系统代理/VPN、全部在线服务、系统/远程语音、深色与计划页、日志脱敏、性能、内存和 ANR 集中验收。
- E2/E3 遗留的正式冷状态/100 次点词 trace 与完整视觉证据需同一批次回填；通过后才关闭 E2–E4 并进入 E5。

## 7. 架构、数据与敏感文件审计

- `src/core` 仍为纯 TypeScript；在线供应商协议、SQLite、Keystore、文件、原生网络、TTS 与音频只存在于平台适配器。
- 没有改写 `formal-v1` migration 1、便携备份 format v1、Sync Model v1 或内容 ID v2；E4 偏好复用既有 `settings` 表，缓存与音频均为可再生数据，不需要 migration 2 或备份格式升级。
- 正式应用不读取、迁移或删除旧 Demo 数据；恢复出厂只调用 Android 对本应用数据的清除。
- 本轮没有提交 EPUB、用户数据库、ECDICT、真实密钥、备份、日志、截图、APK、NSIS 或其他构建产物；最终提交前继续以 `git status --short` 和敏感文件模式审计为准。

## 8. 结论与下一步

E4 的设置、翻译、词典增强、AI 文中义、例句翻译、语音、存储和开发工具已在同一仓库形成可构建、可测试的移动实现，并同步修复 Windows Kimi 批次与无词条文中义问题。当前证据足以进入集中设备验收，但不足以宣称 E4 正式完成。

下一步按[Android 集中真机测试清单](android-device-test-backlog.md)联合关闭 E2–E4 的 API 35 与华为 API 31 门禁；通过后进入 E5，完成跨模块深链、四 tab 状态、生命周期、无障碍和完整 Windows/Android 覆盖审计。F0 才实现 Android 便携备份，不改写正式 format v1。
