# 阶段 E Windows / Android 功能对照账本

> 日期：2026-07-13
>
> 基线：Windows Electron `AppClient` 与阶段 E 计划第 2 节
>
> 状态口径：`已覆盖`、`平台化调整`、`已有薄切片`、`计划`、`后置`、`明确不支持`。E2–E4 当前的“平台化调整”表示代码与自动化已进入集成验证，不等于 API 35/华为真机、生命周期、视觉与性能门禁已经通过。

本账本覆盖阶段 E 计划列出的全部 Windows 能力。Android 不照搬桌面双栏、hover、键盘快捷键或私有目录入口；每项能力必须有移动表达、目标阶段和验收编号。

| 能力 | Android 表达 | Owner | 阶段 | 状态 | 验收 |
| --- | --- | --- | --- | --- | --- |
| 四个一级模块与状态连续性 | 手机底部导航、840 dp 且高度充足时 navigation rail；独立 tab 栈和安全快照 | Shell | E0 | 已覆盖 | E0-NAV-01 |
| Android Back 与沉浸页面 | sheet/dialog 优先、再退当前栈；阅读和答题隐藏一级导航 | Shell | E0 | 已覆盖 | E0-NAV-02 |
| tab 路由、滚动、查询和草稿恢复 | 版本化 WebView 快照；冷启动丢弃敏感与临时状态 | Shell | E0 | 已覆盖 | E0-STATE-01 |
| 全局 busy、错误、任务和成功反馈 | 统一 progress、banner、task bar、snackbar；接入导入、词典安装、翻译与在线服务 | Shell | E0/E4 | 平台化调整 | E0-FEEDBACK-01 |
| 离开模块停止朗读 | Android audio focus、Home/退出阅读器停止与播放生命周期；跨模块集中回归留 E5 | Speech | E4/E5 | 平台化调整 | E4-SPEECH-08 |
| EPUB 导入、取消、重复和错误反馈 | 系统文件选择器、全局任务条、私有 staging | Library | C/E1 | 已覆盖 | E1-LIB-01 |
| 分类、排序、网格/列表 | 横向分类栏、管理/排序 sheet、显式视图切换 | Library | E1 | 已覆盖 | E1-LIB-02 |
| 重命名、删除、选择和批量操作 | 更多菜单、长按及显式选择入口、红色外框和确认 dialog | Library | E1 | 已覆盖 | E1-LIB-03 |
| 封面与刊物元数据 | 两/三/四列响应式封面网格或紧凑列表，显示文章/栏目、分类和日期 | Library | C/E1 | 已覆盖 | E1-LIB-04 |
| 刊物目录与继续阅读 | 手机全页目录、稳定返回、可折叠栏目列表 | Library | C/E1 | 已覆盖 | E1-TOC-01 |
| 正文 block 与图片排版 | 暖纸正文、受控图片协议、移动文章宽度 | Reader | C/E1 | 已覆盖 | E1-READER-01 |
| 稳定阅读锚点 | block/token/比例锚点，文章不使用 shell 通用滚动快照 | Reader | C/E1 | 已覆盖 | E1-READER-02 |
| 当前文章搜索 | 显式搜索按钮、上一项/下一项和系统返回；中文只查已有译文 | Reader | E1 | 已覆盖 | E1-READER-03 |
| 阅读外观 | 设置子页与阅读器 bottom sheet；语义版心保留 Windows 自定义值 | Reader | E0/E1 | 已覆盖 | E1-SETTINGS-01 |
| 全文翻译与译文搜索 | DeepSeek/OpenAI/Kimi 移动进度、取消、失败反馈、缓存译文展开和中文搜索；缓存绑定供应商/模型 | Translation | E4 | 平台化调整 | E4-TRANS-01 |
| 点词、候选、收藏词条/语境 | 阅读器 bottom sheet；可直达词典内“我的生词” | Dictionary | D1/D2/E0 | 已覆盖 | E0-DEEP-01 |
| 段落与连续朗读 | 系统/Google/MiniMax；Android 用顶部入口从可见段落连续朗读，按段跳转、暂停继续/停止并处理 TTS/audio focus，不显示逐段大按钮 | Speech | E4 | 平台化调整 | E4-SPEECH-01 |
| 词典检索 / 我的生词双模式 | 顶部分段控件，分别保存查询、筛选、滚动和详情 | Dictionary | E0/E2 | 平台化调整 | E2-DICT-02 |
| standard/full 词典资源管理 | 统一位于“设置－词典服务”；standard-v1 与独立 full-extension-v1 支持安装、预检、修复、降级、删除、取消和旧 generation 保留 | Dictionary | D1/E2 | 平台化调整 | E2-DICT-01 |
| 英中搜索、防抖、分页 | 180 ms 防抖、latest-wins、取消、总数、分页与索引查询 | Dictionary | D1/E2 | 平台化调整 | E2-DICT-02 |
| 考试词集和高级筛选 | 快捷 chip；tag any/all、Oxford、Collins、BNC、当代词频和排序 FilterSheet | Dictionary | E2 | 平台化调整 | E2-DICT-03 |
| 完整词条详情、徽标、词形与例句 | 手机全页详情与平板响应式布局；共享纯 TypeScript presentation builder 已供 Windows 词典和移动全页详情消费，阅读/学习移动深链复用该详情 | Dictionary | E0/E2/E5 | 平台化调整 | E2-DICT-04 |
| 生词快照与收藏语境 | 无词典时仍显示用户快照，原刊存在时可深链返回；删除后保留不可跳转语境 | Dictionary | D2/E2 | 平台化调整 | E2-VOCAB-01 |
| 百度增强与例句翻译 | Keystore 原子双密钥、30 天缓存、本地回退、中文详释/例句与当前翻译服务例句译文；AI 文中义支持无词条语境 | Dictionary | E2/E4 | 平台化调整 | E4-DICT-01 |
| 今日学习预览、继续和总结 | 手机 dashboard、活动 session 优先恢复、进度、最近词、下一学习日与额外批次 | Study | D3/E3 | 平台化调整 | E3-TODAY-01 |
| new/review/carryover 与强化 | 全屏触摸答题、两阶段确认、改判、强化、太简单与 6 秒撤销 | Study | D3/E3 | 平台化调整 | E3-SESSION-01 |
| 今日词表与筛选 | 全页列表、历史筛选、choice chip 与带 hostTab 的词条详情深链 | Study | E3 | 平台化调整 | E3-TODAY-02 |
| 长期计划管理和来源同步 | 全屏表单、我的生词/考试词集、来源/配额摘要、Windows 对齐的熟练度环图/图例、编辑/暂停/归档和来源版本跳过 | Study | E3 | 平台化调整 | E3-PLAN-01 |
| 计划词表、D/S/R 和逐词操作 | 搜索/分页/状态筛选、due/reps/lapses、排除与暂停复习 | Study | E3 | 平台化调整 | E3-PLAN-02 |
| 阅读外观设置 | Windows 文案动态预览、主题/字号/行距/版心/暖度与恢复默认 | Settings | E0/E1 | 已覆盖 | E1-SETTINGS-01 |
| 翻译、词典、语音设置 | 供应商/模型/声音/偏好、Android Keystore masked 状态、保存替换/删除、连接测试与试听 | Settings | E1/E4 | 平台化调整 | E4-SETTINGS-01 |
| 每日学习参数 | 队列顺序、cutoff、记忆率、最大间隔、保存与撤销；只影响下一批任务 | Settings | E3 | 平台化调整 | E3-SETTINGS-01 |
| 数据与存储 | 分类占用、安全缓存/AI 缓存/日志清理与受控诊断分享；不暴露私有路径 | Data | E4 | 平台化调整 | E4-DATA-01 |
| 便携备份 | format v1 Android 导出、预览和幂等导入 | Data | F0 | 后置 | F0-PORTABLE-01 |
| 开发、日志与恢复出厂 | 隐藏入口、Rust 门控计划删除/学习重置/模拟学习日、脱敏分享和明确危险确认 | Settings | E4 | 平台化调整 | E4-DEBUG-01 |
| 局域网同步 | 版本化逻辑 DTO 传输，不复制 SQLite | Sync | G | 后置 | G-SYNC-01 |
| 打开 Windows 私有数据目录 | Android 仅显示分类占用与受控分享 | Data | E4 | 明确不支持 | E4-DATA-02 |
| 桌面 hover、右键和快捷键 | 显式按钮、更多菜单、sheet 和系统 Back | All UI | E0–E5 | 平台化调整 | E5-UX-01 |

## E0 关闭条件

- E0-NAV-01、E0-NAV-02、E0-STATE-01、E0-FEEDBACK-01、E0-DEEP-01、E0-DICT-01 和 E0-SETTINGS-01 均进入自动测试与视觉 fixture。
- 其余项目均已有明确 owner、阶段和验收编号，不存在“未归类”能力。
- E1 从书库管理与本地阅读开始，不再新增第五种一级导航、另一套全局色值或临时 modal。

## E1 关闭条件

- E1-LIB-01–04、E1-TOC-01、E1-READER-01–03 和 E1-SETTINGS-01 均进入自动测试、API 35 交互和确定性视觉矩阵。
- 书库主页与刊物目录不新增桌面端不存在的搜索；阅读器“当前文章查找”继续保留。
- 六个设置分区均可进入，但翻译、语音、完整学习参数、存储清理与便携备份仍分别保留 E4/E3/F0 状态，不显示假成功按钮。
- E2 词典/我的生词与 E3 背单词并行推进，共同复用 E1 已冻结的紧凑密度、设置路由和服务槽；共享词条详情与深链先冻结接口再分别实现。

## E2/E3 当前关闭状态

- `MobileDictionaryCenterClient v1`、`MobileStudyManagementClient v1`、共享词条 presentation、带 `hostTab` 的 shell v2 深链和 v1 恢复映射已冻结并进入自动测试；Windows 词典与移动全页详情已消费 builder，桌面阅读器抽屉仍由 E5 收口。
- E2-DICT-01–04 与 E2-VOCAB-01、E3-TODAY-01–02、E3-SESSION-01、E3-PLAN-01–02 和 E3-SETTINGS-01 已有移动实现；桌面双栏、modal 和 hover 分别采用全页、sheet 与显式触摸操作。
- 百度增强、AI 文中义、例句翻译、语音及硬删除计划/学习重置/模拟学习日已由 E4 接通；E2/E3 离线数据和队列契约保持不变。
- TypeScript/Rust 自动回归、Android ARM64/x86_64 debug 构建与 Windows NSIS 已通过；API 35 与华为 API 31 性能/视觉证据及连续 100 次词典进页/点词 trace 尚未记录，所以 E2/E3 不能标记为“已覆盖”或阶段完成。当前证据见[阶段 E2 + E3 Android 验证](stage-e2-e3-android-validation.md)。

## E4 当前关闭状态

- `MobileOnlineServices v1`、Android Keystore 与固定 HTTPS allowlist 已进入自动测试；renderer 只接收逻辑 DTO、统一脱敏状态和结构化错误，不获得密钥、任意 URL、路径、SQL、文件系统或原生插件能力。
- E4-TRANS-01、E4-DICT-01、E4-SPEECH-01/08、E4-SETTINGS-01、E4-DATA-01 与 E4-DEBUG-01 已有移动实现；Windows 的侧栏/双栏和 hover 控制分别映射为设置根页/全页卡片和显式触摸按钮。
- 第二轮移动 UI 收敛已取消设置二次分组、把词典资源管理归回设置、让百度选项按来源动态展开，并将书库三列封面、计划环图/常驻筛选和阅读器单一翻译入口纳入确定性视觉 fixture。
- 本机 TypeScript/Rust/Kotlin、双 ABI、Windows NSIS 与六家真实服务脱敏冒烟通过；API 35 覆盖安装、冷启动、设置布局和系统 TTS 试听通过。
- 断网/超时/取消/错误密钥、远程音频连续控制、Home/锁屏/来电/耳机蓝牙、完整尺寸/主题/字体/横屏/TalkBack 及华为 API 31 尚未完成集中设备矩阵，因此 E4 保持“平台化调整/集成验证”，不标记为正式关闭。证据见[阶段 E4 Android 验证](stage-e4-android-validation.md)。
