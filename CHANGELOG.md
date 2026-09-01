# Changelog

All notable changes to PastePaw will be documented in this file.

## v1.4.4

### Security & Offline Hardening
- **Fully Offline Runtime**: PastePaw is now designed to operate 100% offline at runtime with zero outbound network calls.
- **Removed Telemetry (Aptabase)**: Completely removed the Aptabase plugin, startup telemetry events, capability permissions, and SDK dependencies.
- **Removed Automatic Updater & Network Checks**: Completely removed the Tauri Updater plugin, updater capabilities, updater signing workflows, and update check UI.
- **Removed Cloud & AI Networking Code**: Cleaned up all legacy AI API dependencies, prompts, and locale strings.
- **Sanitized Logging & Privacy Hardening**: Prohibited logging raw clipboard content, previews, and user directory paths; only character counts and non-sensitive metadata are logged.
- **Hardened Release Log Level**: Configured release builds to default to `Info` level while preserving `Debug` logging for development builds.
- **Enforced Content Security Policy (CSP)**: Added strict CSP headers (`connect-src 'none'`, `default-src 'self'`) blocking unauthorized network connections in the WebView.
- **Least-Privilege Tauri Capabilities**: Removed unused plugins and capabilities (`opener`, `process`, `updater`, `aptabase`), disabled `withGlobalTauri`, and pruned unused npm/Rust dependencies (`reqwest`, `@tauri-apps/plugin-process`, `@tauri-apps/plugin-opener`, `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-clipboard-manager`).

### Upgrade Notice
- **Manual Upgrade Recommended for v1.4.3 and Earlier**: Due to the migration of the application identifier to `io.github.kisesaki.pastepaw`, auto-update from v1.4.3 is not supported (v1.4.3 still targets the upstream updater endpoint and signature key). When upgrading from v1.4.3 or earlier versions of this fork, please uninstall the previous version before installing v1.4.4. All core user data (clipboard history, pins, notes, images) is safely stored in `%APPDATA%\PastePaw` and will not be deleted during uninstallation. Existing application settings will also be migrated automatically upon first launch.

### Changed
- **Independent Application Identifier**: Migrated Tauri application identifier from `me.xueshi.pastepaw` to `io.github.kisesaki.pastepaw`, establishing an independent identity for this fork.
- **CLI Dependency Upgrade**: Upgraded `@tauri-apps/cli` to `2.11.4`.

### Fixed & Migration
- **Settings Migration Compatibility**: Added automatic settings import from `%APPDATA%\me.xueshi.pastepaw\settings.json` to `%APPDATA%\io.github.kisesaki.pastepaw\settings.json` on first launch when new settings do not yet exist.

### CI & Release
- **Cleaned Upstream Release Workflows**: Removed upstream Winget publishing job (`XueshiQiao.PastePaw`) and Apps Gallery repository dispatch (`XueshiQiao/XueshiQiao.github.io`) from GitHub Actions workflows.

### 安全与离线化加固
- **运行时完全离线**：PastePaw 运行时设计为 100% 纯本地离线运行，消除所有主动外连网络请求。
- **彻底移除 Aptabase 遥测**：移除 `tauri-plugin-aptabase` 插件初始化、启动追踪事件、对应 capability 权限与依赖包。
- **彻底移除自动更新联网功能**：移除 Tauri Updater 插件、检查更新 UI、更新能力配置以及 CI 中的 Updater 签名密钥依赖。
- **清理云端/AI 网络遗留代码**：彻底移除所有 AI API 相关依赖、提示词与多语言废弃文案。
- **日志隐私加固**：严禁在日志中输出剪贴板实际内容、文本预览与敏感用户目录路径，仅记录字符长度与基础元数据。
- **正式版日志等级收紧**：正式发布版默认采用 `Info` 日志等级，开发调试版保留 `Debug` 日志。
- **严格 CSP 安全策略**：引入 CSP 策略（包含 `connect-src 'none'`、`default-src 'self'`），在 WebView 层彻底阻断外部网络连接。
- **最小化 Tauri 权限与依赖精简**：移除 `opener`、`process`、`updater`、`aptabase` 等权限，关闭 `withGlobalTauri`，清理无用 npm 与 Rust 依赖包（`reqwest`、`@tauri-apps/plugin-process`、`@tauri-apps/plugin-opener`、`@tauri-apps/plugin-updater`、`@tauri-apps/plugin-clipboard-manager`）。

### 升级说明
- **v1.4.3 及更早版本建议手动重装**：因本次版本调整了应用内部 identifier，v1.4.3 仍使用旧版更新源与上游签名公钥，因此不支持从 v1.4.3 自动更新至 v1.4.4。从 v1.4.3 及更早的本 Fork 版本升级时，建议先卸载旧版再安装 v1.4.4。用户的剪贴板历史、收藏、便签、图片等核心数据均独立保存在 `%APPDATA%\PastePaw` 中，卸载程序不会删除这些数据；旧版设置也会在首次启动新版时自动平滑迁移。

### 变更
- **独立应用标识符**：将 Tauri Application Identifier 从 `me.xueshi.pastepaw` 迁移为 `io.github.kisesaki.pastepaw`，确立当前 Fork 独立的系统应用身份。
- **依赖版本升级**：升级 `@tauri-apps/cli` 至当前已验证的 `2.11.4`。

### 修复与迁移
- **旧版设置平滑兼容**：增加旧版设置自动迁移逻辑，首次启动新版且新配置文件不存在时，自动从 `%APPDATA%\me.xueshi.pastepaw\settings.json` 导入配置至 `%APPDATA%\io.github.kisesaki.pastepaw\settings.json`。

### CI 与发布
- **清理上游发布任务**：移除 Fork 中继承的上游 Winget 自动发布任务（`XueshiQiao.PastePaw`）以及向 `XueshiQiao/XueshiQiao.github.io` 发送 Apps Gallery repository dispatch 的工作流逻辑。

## v1.4.3

### Added
- Smooth Show/Hide Transition Animations: Added fluid height and opacity CSS transitions for the floating notepad window's header, formatting toolbar, and action footer when hovering/focusing or blurring/unhovering.

### Fixed
- Fixed raw HTML leaking into note titles: Note titles now properly filter out raw HTML tags (e.g. `<ul><li><p>...`) in the database, editor input, and sidebar list, automatically falling back to clean plain-text previews for untitled notes.
- Fixed list item numbers and bullet markers in Tiptap Markdown editor by isolating list styles from Tailwind preflight CSS reset.
- Extended task list input rule to support typing `[] ` and `[ ] ` directly without requiring `- ` prefix.
- Fixed notepad window minimize button not minimizing the window and always-on-top toggle cancellation.
- Added complete localization coverage for Chinese and English in the notepad window (tooltips, search placeholders, action labels, and toast notifications).

### 新增
- 便签窗口平滑过渡显隐动画：为独立便签窗口的顶部标题栏、格式工具栏与底部操作栏添加流畅的渐变折叠/展开过渡动效，悬浮聚焦与失焦离开时不再生硬突变。

### 修复
- 修复便签侧边栏与主窗口标题错误显示 HTML 标签的问题：彻底过滤富文本标签（如 `<ul><li><p>...`），未命名的便签自动回退显示干净的纯文本内容预览。
- 修复便签输入有序列表与无序列表时标号与圆点丢失的问题：隔离 Tailwind preflight 样式重置，确保列表样式正常显示。
- 扩展待办任务输入规则：支持输入 `[] ` 与 `[ ] ` 直接快速创建待办复选框。
- 修复便签窗口点击最小化按钮无效以及取消置顶未实时生效的问题。
- 补全便签窗口中英文国际化语言包：修复复制提示、搜索框占位符、工具栏格式提示等多处未翻译文本。

## v1.4.2

### Fixed
- Fixed notepad window background transparency leak where desktop background remained visible regardless of opacity slider level
- Fixed notepad color theme backgrounds to properly render solid pastel tints over a solid base layer
- Clarified notepad window opacity terminology in Chinese locale ("窗口不透明度")

### 修复
- 修复便签窗口背景漏光穿透问题：解决无论透明度拉到 30% 还是 100% 均能透过窗口看到底层桌面或应用程序的 Bug
- 优化便签主题色彩渲染层级：确保便签淡雅色调在实体基底背景上正确融合呈现，100% 不透明度下完全实心不透光
- 优化便签窗口不透明度文案：统一中文语言下为“窗口不透明度”，消除 100% 极值认知歧义

## v1.4.1

### Added
- Tiptap WYSIWYG Markdown Note Editor: full support for task lists (interactive clickable checkboxes), bullet lists, numbered lists, bold, strikethrough, inline code, headings (`# `, `## `), links, and horizontal dividers (`---`)
- Floating Bubble Menu: context-sensitive format bar pops up upon text selection for quick styling
- Draggable & Responsive Sidebar: drag resize divider with standard, compact, mini, and auto-collapse responsive modes
- Auto-launch Pinned Notes: automatically opens the notepad window on startup if there are pinned notes or if notepad window was pinned
- Clean Markdown Export: copying all note content or pasting to external applications automatically formats into clean standard Markdown/plaintext

### Fixed
- Fixed opacity dropdown popover z-index layering issue
- Fixed footer status bar and action buttons wrapping on narrow windows

### 新增
- Tiptap 所见即所得 Markdown 便签编辑器：全面支持待办任务清单（可鼠标直接点击打勾）、无序圆点列表、有序数字列表、粗体、中划线、行内代码、多级标题（`#` / `##`）、链接与水平分隔线（`---`）
- 浮动格式菜单（Bubble Menu）：选中文本时光标上方自动弹出快捷格式化气泡栏
- 侧边栏拖拽调宽与多级自适应：按住分割线自由调节宽度，支持标准、精简、Mini 图标与自动吸附折叠形态
- 置顶便签开机自启拉起：启动时若存在置顶便签或窗口置顶状态，自动呼出便签窗口
- 干净标准 Markdown 导出：点击复制全文或一键粘贴至应用时，后台自动智能无损转换为标准 Markdown/纯文本
- 快捷格式工具栏：便签顶部新增加粗、划线、待办、列表与代码快捷按钮

### 修复
- 修复便签窗口透明度调节浮层被工具栏元素遮挡的层级问题
- 修复便签在窄窗口或侧边栏拉宽时底部操作栏按钮折行换行的问题

## v1.4.0

### Added
- Independent Floating Notepad Window: Frameless, draggable, resizable, and always-on-top desktop quick notes with customizable window opacity (40%–100%)
- Multi-note management: Collapsible sidebar, real-time search, color theme tags, pin notes, and debounced auto-saving to SQLite
- Direct paste-to-app (`Ctrl+Enter`): Directly write note content to clipboard and simulate keystroke paste into previous foreground application
- Clip-to-Note conversion: Save any text clipboard history item into a permanent note via context menu
- Shortcuts & quick actions: `Ctrl+N` for new note, `Ctrl+Shift+C` to copy all text, and dedicated launcher button in ControlBar and system tray menu

### Fixed
- Fixed floating main window auto-hide behavior when opening settings window

### 新增
- 独立浮动置顶记事本窗口：支持无边框自由拖拽、四周边缘缩放、始终置顶 (Always on Top) 与窗口透明度调节（40%~100%）
- 多便签与管理系统：支持折叠式左侧抽屉、实时搜索、主题色标签、置顶便签与 SQLite 防抖实时自动保存
- 一键粘贴至应用 (`Ctrl+Enter`)：直接将便签内容自动写入剪贴板并模拟按键粘贴至底层活动窗口
- 剪贴记录转存便签：支持在剪贴板卡片右键菜单中一键“保存为便签”
- 便捷操作与快捷键：支持 `Ctrl+N` 快速新建、`Ctrl+Shift+C` 复制全文、底部控制栏按钮及系统托盘菜单快速呼出

### 修复
- 修复打开设置窗口时主悬浮窗无法自动隐藏的问题

## v1.3.9

### Added
- Multi-criteria clipboard sorting: support sorting by newest first, oldest first, application source, content type, and character length
- Direct number key paste: quickly paste first 9 clips using number keys `1`~`9` or `Ctrl+1`~`Ctrl+9` with card shortcut badges
- Plain-text clean paste: strip rich format/HTML with shortcut `Shift + Enter` or context menu
- Pin / favorite clips: pin clips to stay on top with `P` shortcut, hover button, and amber indicator badge
- Smart content detection: visual color swatches & HEX copy, URL detection & open link, and JSON formatter
- Clipboard storage management: customize history capacity limit (`max_items`) and retention period (`auto_delete_days`, default forever)

### Fixed
- Fixed context menu appearing in English when app language is set to Chinese
- Fixed smooth hide animation when auto-hiding window upon clicking outside (blur)

### 新增
- 剪贴板多维度排序：支持按最新复制、最早复制、应用来源、内容类型及字符长度排序
- 数字键直接粘贴：前 9 项显示 `1`~`9` 快捷徽标，支持按 `1`~`9` 或 `Ctrl+1`~`Ctrl+9` 直接粘贴
- 纯文本清洁粘贴：支持 `Shift + Enter` 快捷键或右键菜单直接粘贴无格式纯文本
- 剪贴项置顶/收藏：支持按 `P` 或悬浮按钮置顶剪贴项，置顶项始终固定在列表首位
- 智能内容识别与预览：支持色值识别与色块预览/复制、链接识别与浏览器打开、JSON 结构化预览与格式化
- 剪贴板容量与保存周期设置：支持自定义最大历史条数及保留天数（默认永久）

### 修复
- 修复中文模式下右键剪贴项菜单显示为英文的问题
- 修复点击悬浮窗外部自动隐藏时的平滑过渡隐藏动画

## v1.3.8

### Improved
- Selection behavior: opening window now defaults selection to the newest clipboard item and resets scroll to 0, ensuring newly copied clips are immediately accessible
- Top on paste: pasting any clip now moves it to the top of the history list (Paste-app style)

### Fixed
- Fixed auto-paste on Windows 11 by switching simulated keystrokes to standard `Ctrl + V` (`VK_CONTROL` + `VKEY(0x56)`) instead of `Shift + Insert`
- Fixed floating window auto-hide when clicking outside (blur), including settings window visibility check and foreground focus activation

### 优化
- 选择逻辑优化：重新打开窗口默认聚焦最新的剪贴项并重置滚动位置，确保新复制内容即时可见
- 粘贴置顶：粘贴任意历史剪贴项后自动将其置顶（类 Paste 体验）

### 修复
- 修复 Windows 11 系统下双击粘贴失效问题，改用通用 `Ctrl + V` 模拟输入
- 修复点击悬浮窗外部自动隐藏失效问题，并完善设置窗口状态判断与前台焦点激活

## v1.3.7

### Added
- German, French, and Japanese language support

### Improved
- Winget release pipeline: hash verification step added before publishing to winget-pkgs to prevent stale-hash mismatches; release tag now explicitly pinned

### 新增
- 新增德语、法语、日语语言支持

### 优化
- Winget 发布流程：在发布至 winget-pkgs 前增加哈希值校验步骤，防止哈希不匹配问题；发布时明确指定 release tag

## v1.3.6

### Added
- Support floating window above the taskbar (toggle in Settings)
- Every release is now automatically scanned with VirusTotal (70+ antivirus engines) — scan results are linked in the release notes

### 新增
- 窗口支持浮动在任务栏上层（可在设置中开启/关闭）
- 每次发布版本现在会自动通过 VirusTotal（70+ 款杀毒引擎）进行安全扫描，扫描结果链接附在 Release 说明中

## v1.3.5

### Added
- Native rounded corners support for all window effects (Mica, Mica Alt, Clear) using Windows 11 DWM — toggle on/off in Settings

### Fixed
- Fixed TypeScript build error caused by missing Vite client types (`import.meta.env`)

### 新增
- 所有窗口效果（Mica、Mica Alt、Clear）均支持原生圆角，通过 Windows 11 DWM 实现，可在设置中开启/关闭

### 修复
- 修复因缺少 Vite 客户端类型导致的 TypeScript 构建错误（`import.meta.env`）

## v1.3.4

### Added
- Brand new native style look with Windows Mica and Mica-Alt window effects for a seamless, beautiful appearance that blends with your desktop

### 新增
- 全新原生风格外观，支持 Windows Mica 和 Mica-Alt 窗口效果，与桌面完美融合，带来更精美的视觉体验

## v1.3.3

### Changed
- Refined UI layout: reduced window height, tightened card spacing, fixed control bar height, and removed CSS shadow in Clear window effect mode

### 变更
- 优化界面布局：减小窗口高度、收紧卡片间距、固定控制栏高度，并在"无效果"窗口模式下移除 CSS 阴影

## v1.3.2

### Fixed
- Fixed hotkey toggle broken after changing hotkey in settings (issue #6)
- Fixed winget package missing arm64 installer by switching to NSIS setup.exe for architecture detection (issue #7)

## v1.3.1

### Fixed
- Removed white/alpha border around settings window in dark mode

