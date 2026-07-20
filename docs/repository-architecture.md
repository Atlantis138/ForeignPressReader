# 外刊阅读器多平台仓库规划

> 状态：正式仓库结构决策
> 当前 Git 根目录：`<repo-root>`
> 最后更新：2026-07-12

## 1. 决策

本产品采用一个 Git 仓库，不为 Windows、Android 和 iOS 分别建立独立仓库。不同平台需要各自的平台工程和应用外壳，但共享领域规则、数据契约、React 组件及测试资产应只有一个来源。

当前项目规模适合“单仓库、单前端包、多个平台外壳”，暂不进行大型 monorepo 拆包：

- Electron Windows 外壳保留在 `src/main` 和 `src/preload`。
- Tauri Android/iOS 外壳使用标准 `src-tauri`；Android Studio 打开其生成的 Android 工程，但 Git 工作仍从仓库根目录进行。
- `src/core`、`src/shared` 和可共享 renderer 代码同时服务两个外壳。
- 桌面与移动端各自需要的导航和交互组件在 renderer 内分层，不通过复制整个应用实现。
- 只有出现真正独立的构建、版本或依赖边界时，才把共享模块提升为 `packages/*` workspace 包。

这既是行业常见的 monorepo 思路，也避免为个人项目引入不产生收益的发布编排和包版本管理。

## 2. 目录职责

阶段 A 初始化 Tauri 后，仓库的目标结构如下：

```text
ForeignPressReader/
├─ .github/                 GitHub 模板和未来可选的 CI
├─ docs/                    架构、路线、数据格式和 ADR
├─ scripts/                 构建、性能和维护脚本
├─ src/
│  ├─ core/                 纯 TypeScript 领域规则和平台端口
│  ├─ shared/               跨外壳 DTO、AppClient 契约和兼容类型
│  ├─ renderer/
│  │  ├─ shared/            两端确实共用的状态、组件和视觉令牌
│  │  ├─ desktop/           桌面导航和桌面专用交互
│  │  └─ mobile/            移动导航、触摸、安全区和返回键交互
│  ├─ main/                 Electron 主进程和 Windows 适配器
│  └─ preload/              Electron IPC 桥
├─ src-tauri/
│  ├─ src/                  Rust 组合根、commands 和 Android/iOS 适配器
│  ├─ capabilities/         Tauri 权限声明
│  ├─ gen/android/          Tauri 生成的 Android Gradle 工程
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ tests/                   TS 单元、契约、迁移和 Electron 端到端测试
├─ test-vectors/            未来跨 TS/Rust 的固定兼容向量
├─ package.json             产品版本和根命令
├─ pnpm-lock.yaml           唯一 JavaScript 依赖锁
├─ pnpm-workspace.yaml      pnpm 安全策略；未来可扩展 workspace
└─ Cargo.lock               Tauri 初始化后提交的 Rust 依赖锁
```

目录图表示目标职责，不要求现在建立空目录。文件只在对应阶段产生真实代码时创建。

## 3. 哪些内容共享，哪些内容分开

### 必须共享

- 领域实体、稳定 ID、内容 ID、FSRS 语义和同步合并策略。
- `AppClient` 能力接口、逻辑 DTO、错误代码和兼容向量。
- 正式 migration、便携备份和 Sync Model 的版本定义与验收测试。
- EPUB 规范化语义、词元规则、供应商注册和用户偏好模型。
- 设计令牌及没有平台交互假设的展示组件。

### 必须按平台实现

- Electron IPC 与 Tauri invoke/event 桥。
- SQLite 驱动、文件选择、持久目录、密钥存储和网络栈。
- Windows 系统代理、DPAPI 和安装程序。
- Android 权限、Keystore、返回键、生命周期、文件选择和必要的 Kotlin 插件。
- iOS 签名、Keychain、文件选择和必要的 Swift 插件。
- 桌面窗口式导航与移动触摸式导航。

共享的是语义和稳定契约，不是物理数据库文件、平台路径或每一行 UI 代码。

## 4. 为什么现在不拆成多个项目仓库

分别建立 `windows-repo`、`android-repo` 和 `ios-repo` 会带来以下问题：

- 同一个 DTO、迁移和 bug 修复需要重复修改并人工保持一致。
- 跨平台兼容测试难以在同一提交中审查。
- 功能版本和发布说明容易漂移。
- 单人维护需要处理多个 issue、tag、依赖更新和分支状态。

只有平台产品由独立团队维护、发布周期完全不同、代码共享已经很少，或存在访问控制要求时，拆成多个仓库才有明显收益；当前均不满足。

## 5. 何时升级为真正的多包 workspace

`pnpm-workspace.yaml` 已作为依赖安全配置存在，但当前只有根包。满足以下任一条件后再评估 `apps/*`、`packages/*`：

- Windows 与移动端需要独立前端入口、依赖集和构建缓存。
- `src/core` 可以形成无 Electron/Tauri 依赖、拥有独立测试和清晰公共 API 的包。
- 共享 UI 已形成稳定组件边界，而不是频繁跨目录修改的页面代码。
- 根依赖冲突或构建时间已经成为可测量问题。
- 需要独立发布或被仓库外其他程序复用。

届时建议一次只提取一个稳定边界：先 `packages/contracts` 或 `packages/core`，再评估 `packages/ui`；不要一次性把所有目录搬入 `apps` 和 `packages`。

## 6. Git 与分支流程

- `main` 始终保持可构建、可测试；正式基线使用注释 tag，例如 `v1.0.0-alpha.1`。
- 功能使用短期分支，例如 `prototype/tauri-android`、`feature/android-storage`，通过后合并并删除。
- 不建立长期 `android`、`windows` 分支；平台差异存在于目录和适配器，不存在于永久分叉的历史。
- 每个提交只解决一个可验证问题。脚手架、数据库、移动 UI 和同步不得混成一次提交。
- 重要架构选择写入 `docs`；改变已发布数据契约时同时更新迁移、兼容测试和 CHANGELOG。
- GitHub 仓库根目录就是本目录内部内容，不上传仓库父目录、`node_modules`、构建产物或本机环境文件。

## 7. 依赖与供应链规则

- JavaScript 使用锁定的 pnpm 版本和唯一 `pnpm-lock.yaml`。
- pnpm 11 的依赖安装脚本通过 `pnpm-workspace.yaml` 的 `allowBuilds` 逐项审核，禁止全局允许所有脚本。
- Rust 应用提交 `Cargo.lock`，依赖升级与 Tauri CLI/API 升级放在独立提交中。
- Android 使用 Tauri 生成的 Gradle wrapper；不依赖机器全局 Gradle 版本。
- Tauri CLI 作为项目 `devDependency` 固定，团队命令从仓库根目录执行。
- 密钥、签名文件、用户数据库、真实 EPUB、ECDICT 数据包和诊断日志永不进入 Git。

## 8. 构建与验证矩阵

| 变化范围 | 最低验证 |
| --- | --- |
| 纯 core/contracts | TypeScript 类型检查、单元测试、兼容向量 |
| Electron 适配器或桌面 UI | 上述验证、Electron 测试、Windows 构建 |
| Tauri/Rust | 上述验证、`cargo test`、`cargo clippy`、Android target 编译 |
| Android UI/权限/生命周期 | 上述验证、华为 API 31 真机、API 35 模拟器 |
| migration/备份/同步模型 | 两端兼容向量、升级/回滚、幂等与高版本拒绝 |
| 发布 | 全量测试、性能基线、干净安装、覆盖升级、备份恢复 |

CI 可以在准备上传 GitHub 后逐步加入，但 CI 只是执行这些规则，不能替代真机和安装包验收。

## 9. 渐进式实施顺序

1. 保持当前 Electron 目录不动，先完成 Tauri 阶段 A 的真机启动原型。
2. 根据真实依赖建立 `src-tauri`，不提前创建空的 `apps/android` 或复制 renderer。
3. 在数据库阶段固定 `AppClient`/repository 边界和 `test-vectors`。
4. 在首个移动页面出现时再把 renderer 逐步分为 shared/desktop/mobile。
5. Android 本地 Beta 稳定后评估是否需要提取 `packages/core`；没有明确收益则继续单包结构。

该顺序确保每次结构调整都由已出现的代码边界驱动，并且每一步都可以从最近 tag 回退和比较。
