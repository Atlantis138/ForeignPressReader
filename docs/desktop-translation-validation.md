# Windows 目录与翻译更新验证

> 本文记录 2026-09-11 的历史范围；目录缓存持久化与 Android 对齐已由 [2026-10 双端验证](cross-platform-parity-2026-10.md) 更新。

范围：仅桌面界面和 Electron 适配器；不更新 Android 界面、不构建或安装 Android 包。

## 自动验证

- `desktop-translation.test.ts`：自定义模型按供应商去重、数据库关闭重开后保留、删除当前模型回退、切回内置模型、设备本地配置不导出；目录分批请求、漏项重试、缓存复用、模型/目录改变后失效、强制重译与取消后保留部分结果。
- `desktop-contents-behavior.test.ts`：异步目录加载后恢复位置、卸载保存位置、翻译错误后继续、原文与译文并列、显示状态保留。
- `electron-ui.test.ts`：用临时生成的 30 篇文章 EPUB 验证长目录进入文章、返回目录和切换主页面后的滚动位置；验证实际计算字号随阅读工具栏改变，以及模型输入、保存、切页后恢复和删除。

2026-09-11 验证：`pnpm typecheck`、`pnpm lint` 通过（零警告、零依赖违规）；`pnpm test` 通过，50 个测试文件通过、1 个按环境跳过，253 项通过、3 项跳过。完整测试同时构建桌面 renderer 和 Electron 主进程，并运行真实 Electron 交互测试。已检查翻译设置和目录界面截图。

## Windows 覆盖安装（2026-09-11）

`pnpm dist` 与 `pnpm test:protocol:packaged` 通过。生成 `ForeignPressReader-1.0.0-Setup.exe`（99,033,938 bytes），SHA-256 为 `F898D5DC22A608B6E6CC4C49AB72917BDC86935D0D7D447E0B590B93CE814EBC`。版本号保持 1.0.0，本机构建包含本轮桌面功能更新。

按用户要求在原 Windows 正式版目录覆盖安装，安装器退出码 0；安装后的 `app.asar` 与本次构建一致，启动前核对原 `reader.sqlite` 的 SHA-256 未改变。随后启动已安装应用。未操作 Android 安装。

## 边界

目录译文和目录位置为本次运行的临时状态；自定义模型为本机服务配置，不随备份或同步转移。自动测试使用合成 EPUB、临时数据库和模拟模型响应，不调用用户付费 API；实际模型是否支持结构化翻译由“测试所选模型”和供应商响应判断。
