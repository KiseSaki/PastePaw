# Changelog

All notable changes to PastePaw will be documented in this file.

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

