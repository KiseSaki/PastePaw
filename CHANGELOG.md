# Changelog

All notable changes to PastePaw will be documented in this file.

## v1.6.1

### Fixed
- **Intermittent Clipboard Capture**: Wait and retry when clipboard text/images are temporarily unavailable. Cancel stale reads when another copy occurs, and reread the latest system version after delayed rendering.
- **Capture Deduplication**: Commit the saved clipboard version only after successful persistence. New copy/cut operations with existing text can move the entry to the front; recent self-pastes preserve the original source.
- **History Ordering and Retention**: Parse mixed SQLite/ISO timestamps before pagination, search, eviction and sync selection. Save new captures with subsecond UTC timestamps so recently captured content is not hidden behind older records or evicted incorrectly.

### 修复
- **剪切板偶发漏记**：文字或图片暂时不可读时等待重试；新的复制到来时取消旧读取，延迟渲染导致系统版本变化后重新读取最新内容。
- **采集去重状态**：成功保存后才提交已处理版本；重新复制或剪切已有正文也能更新位置，程序近期自行粘贴保留原来源。
- **历史排序与保留**：分页、搜索、淘汰及同步选择前解析混用的 SQLite/ISO 时间。新采集使用带亚秒精度的 UTC 时间，避免新内容被旧记录挡住或错误淘汰。

## v1.6.0

### Added
- **Optional SiYuan Return Sync**: Plugin 0.3.0 manually returns changes from bound note regions through WebDAV, including titles, rich text, tasks and attachments. Ordinary blocks can be explicitly created as new notes; detaching or deleting a SiYuan region preserves the cloud note.
- **Conflict Review**: The note window and plugin compare preserved versions and support keeping either version, keeping both or manually merging. Stale decisions are refused and resolved-version markers prevent repeated conflict copies from offline retries.

### Improved
- **Three-Way Merge Across Devices**: Use the common baseline to combine independent fields and non-overlapping body edits. Overlapping edits, uncertain structures and delete/edit conflicts retain versions for review instead of silently choosing the newest clock.
- **Safe Return Writes**: Share the native cloud lease and conditional-write checks, verify uploaded bytes and enforce attachment/cloud limits. Checkpoints recover interrupted bindings; unsupported SiYuan content and edits during synchronization remain preserved.

### Upgrade Notes
- Upgrade all computers to PastePaw 1.6.0 and the plugin to 0.3.0 (SiYuan 3.8.6 or later). Notes migrate to format 3; old clients pause synchronization. Existing vaults remain usable. Bidirectional plugin synchronization is opt-in and needs a writable WebDAV account.
- Document baseline files contain note content, not connection credentials. Real Windows/Android SiYuan conversion and the user's server still need installation testing. See [the plugin guide](siyuan-plugin/README.zh-CN.md).

### 新增
- **可选思源回传同步**：插件 0.3.0 点击按钮将已绑定便签区域的标题、富文本、待办及附件回传 WebDAV。普通块可明确创建为新便签，解除绑定或删除思源区域保留云端便签。
- **冲突比较与处理**：便签窗口和插件均可比较两版、保留一版、保留两版或手动合并；拒绝过期决策，持久保存处理标记，避免离线重试反复生成冲突副本。

### 改进
- **多端三方合并**：使用共同基线合并独立字段和不重叠的正文修改；重叠编辑、结构无法确认或编辑与删除冲突保留版本供处理，不凭设备时间静默覆盖。
- **回传写入保护**：与电脑端共用云端租约和条件校验，校验上传内容并遵守附件/总容量限制。检查点恢复中断绑定，保留不支持的思源内容及同步期间的新编辑。

### 升级说明
- 所有电脑升级至 PastePaw 1.6.0，插件升级至 0.3.0（思源 3.8.6 或更新版本）。便签格式迁移为 3，旧客户端暂停同步；已有加密凭据继续使用。插件双向同步默认关闭，开启需要 WebDAV 写权限。
- 文档基线包含便签内容，不含连接凭据；真实 Windows/安卓思源转换及用户服务器仍需安装验收。见[插件说明](siyuan-plugin/README.zh-CN.md)。

## v1.5.0

### Added
- **Note Editor Tools**: Add current-note find/replace, a slash insertion menu, italic/underline/highlight/clear-format controls and link editing. Code blocks provide language selection, syntax highlighting and individual copy buttons.
- **Tables and Block Operations**: Insert and edit tables, paste Excel tables or TSV, move/duplicate/delete blocks and drag blocks within their parent. Fold headings and list children while retaining the full content for saving, copying and synchronization.
- **Note Images and Attachments**: Paste screenshots or insert files, save attachments separately, deduplicate by SHA256 and synchronize original files through WebDAV. The SiYuan plugin 0.2.0 validates and uploads resources before importing linked note content.

### Fixed
- **Mixed List Nesting**: Preserve parent/child structure when converting bullet, numbered and task lists. Tab, Shift+Tab and empty-item Enter act on the nearest item, including children of a task list.
- **Markdown Fidelity**: Parse pasted Markdown and preserve nested tasks, numbered-list starts, code language/whitespace, multiline quotes and tables when copying or importing. Share the converter with the SiYuan plugin.

### Upgrade Notes
- Upgrade all syncing computers to PastePaw 1.5.0 and the SiYuan plugin to 0.2.0 (SiYuan 3.8.6 or newer). Notes migrate to sync format 2; older clients reject it to protect attachment metadata. Existing notes and encrypted connection vaults remain usable.
- Attachments are limited to 20 MiB each and 500 MiB locally, and count toward the configured cloud total. Backups retain their referenced files; full storage stops uploads and preserves local content. See [the editor guide](docs/note-editor.md).

### 新增
- **便签编辑工具**：正文查找替换、斜杠插入菜单、斜体/下划线/高亮/清除格式及链接编辑；代码块支持选择语言、语法高亮和单独复制。
- **表格与块操作**：插入和编辑表格，粘贴 Excel 表格或 TSV，移动/复制/删除块及同级拖动。标题和列表支持折叠，保存、复制和同步仍保留完整正文。
- **便签图片与附件**：粘贴截图或插入文件，另存附件，按 SHA256 去重并通过 WebDAV 同步原文件。思源插件 0.2.0 校验资源并保存到思源后再导入带链接的正文。

### 修复
- **列表混合嵌套**：无序、有序、待办列表互相转换时保留父子结构；Tab、Shift+Tab 和空项回车操作最近的列表项，支持待办父项中的其他列表。
- **Markdown 保真**：粘贴 Markdown 自动转换；复制及思源导入保留嵌套待办、有序起始编号、代码语言和空白、多段引用及表格。便签和思源插件共用转换器。

### 升级说明
- 所有同步电脑升级至 PastePaw 1.5.0，思源插件升级至 0.2.0（思源 3.8.6 或更新版本）。便签同步格式迁移为版本 2，旧客户端会拒绝读写，防止覆盖附件索引；已有便签和加密连接凭据可继续使用。
- 单附件上限 20 MiB，本地附件总量上限 500 MiB，云端计入设置中的总额度；保留备份引用的资源，容量不足时停止上传并保留本地内容。操作方法见[编辑器说明](docs/note-editor.md)。

## v1.4.8

### Added
- **Optional WebDAV Sync**: Sync all notes bidirectionally across computers, with configurable clipboard count, image size, clipboard storage and total storage limits. Concurrent note edits retain conflict copies; manual deletion propagates while local history eviction does not.
- **Encrypted Connection Credentials**: Save the WebDAV address, directory, username and password together in an encrypted vault beside the executable. Supports HTTP/HTTPS, independent unlock passwords of at least 6 characters, automatic locking and pausing clipboard capture while entering credentials.
- **SiYuan Note Import Plugin**: A Windows/Android plugin manually pulls notes into a selected document. Repeated imports reuse existing blocks, manually edited content is preserved, and device credentials are encrypted separately.
- **Plugin Release Asset**: Automatically build and attach the SiYuan plugin ZIP alongside the Windows x64 and ARM64 installers.

### Fixed
- **Apache WebDAV Compatibility**: Retry briefly when newly uploaded files return a temporary weak ETag, including `bytemark/webdav`. Strong ETag and conditional-write checks remain required for bidirectional sync.
- **Sync During Editing**: Protect pending note saves and edits made during a sync operation. Deduplicate imported clipboard entries and retain original images.
- **WebDAV Settings Icon**: Add a cloud icon aligned with the other settings navigation items.

### Usage Notes
- WebDAV sync is disabled until configured. HTTP sends credentials and synchronized content in plaintext; vault encryption protects local connection settings rather than cloud note content.
- Client storage limits do not replace server-side quotas. See [the sync guide](docs/webdav-sync.md) for setup, credential cleanup and SiYuan plugin installation.

### 新增
- **可选 WebDAV 双向同步**：多台电脑全量同步便签，剪切板支持配置条数、单图大小、剪切板容量和总容量。并发编辑保留冲突副本；手动删除跨端传播，本地历史淘汰不会删除云端内容。
- **连接凭据加密保存**：地址、目录、账号和密码一起加密保存在安装目录，支持 HTTP/HTTPS、至少 6 个字符的独立解锁密码、自动锁定，以及输入凭据时暂停剪切板采集。
- **思源便签导入插件**：支持 Windows 和安卓，点击按钮将 WebDAV 便签拉取到指定文档，重复导入复用已有块，保留手动编辑内容，各设备连接凭据分别加密。
- **插件自动发布附件**：自动构建思源插件 ZIP，与 Windows x64、ARM64 安装包一起发布。

### 修复
- **Apache WebDAV 兼容性**：新上传文件短暂返回弱 ETag 时等待后重新读取，兼容 `bytemark/webdav`，继续保留强 ETag 和条件写入校验。
- **同步期间编辑保护**：保护未完成的便签自动保存及同步期间发生的本地编辑；避免剪切板导入重复记录，并保留完整原图。
- **WebDAV 设置图标**：补齐云图标，与其他设置菜单项对齐。

### 使用说明
- WebDAV 同步默认关闭，需要配置后启用。HTTP 会明文传输凭据和同步内容；凭据文件加密保护的是本地连接设置，云端便签内容不进行端到端加密。
- 客户端容量限制不能替代服务器硬配额。配置、凭据清理和思源插件安装方法见[同步说明](docs/webdav-sync.md)。

## v1.4.7

### Added
- **Active & Completed Note Management**: Introduced full lifecycle status management for notepad notes. Users can now categorize notes as active or completed, keeping active tasks focused and noise-free.
- **Sidebar Tab Segmentation**: Added pill-style filter tabs (`Active (N)` / `Completed (M)`) in the notepad sidebar with mini-mode icon support. Includes a one-click "Clear Completed" action with confirmation.
- **Task List Progress Parsing**: Automatically parses task checkboxes (`[ ]` / `[x]`) within note content to display real-time completion badges (e.g. `✓ 2/3`) on note cards.
- **Quick Status Toggle & Shortcut**: Added a status toggle button on note cards and the editor toolbar, along with a `Ctrl+D` shortcut to quickly mark notes as completed or active.
- **Seamless Database Migration**: Automatically adds the `is_completed` column and index to the SQLite `notes` table without data loss or breaking existing user notes.

### Fixed
- **Task Item Checkbox & Text Alignment**: Fixed an issue where text entered in a task list item wrapped to the next line beneath the checkbox rather than aligning horizontally next to it. Enforced flexbox inline alignment and removed paragraph margin offset.

### 新增
- **便签「进行中 / 已完成」分类管理**：为记事本增加了便签生命周期管理支持，区分进行中与已完成便签，避免待办事项堆积干扰视线。
- **侧边栏分段药丸过滤栏**：侧边栏顶部新增 `[进行中 (N)]` 与 `[已完成 (M)]` 过滤药丸标签（Mini 极窄模式自适应为小图标），并在已完成视图下提供“清空已完成”安全清理操作。
- **待办清单进度智能感知**：自动解析便签文本中的待办复选框（`[ ]` / `[x]`），在侧边栏卡片上实时呈现完成度进度徽标（如 `✓ 2/3`，全部完成为高亮 `✓ 3/3`）。
- **快捷切换状态与快捷键**：卡片悬浮操作栏与编辑器顶部工具栏均增加状态切换按钮，并支持快捷键 `Ctrl+D` 快速标记当前便签为完成或恢复。
- **数据库平滑无损迁移**：SQLite `notes` 表自动新增 `is_completed` 字段及索引，无缝兼容老版本数据，历史便签默认保留在进行中。

### 修复
- **待办清单复选框与文字换行对齐问题**：修复了在待办项中输入文字时文字被换行到复选框下方的 BUG，统一待办项的水平流式弹性盒布局并优化段落边距，保证复选框与文字在同一行完美对齐。

## v1.4.6

### Fixed
- **Cross-Note Undo and Data Isolation**: Resolved an issue where ProseMirror undo/redo history stacks lingered across different notes. Resetting the history state when switching or creating notes prevents pressing `Ctrl+Z` in a newly selected note from undoing back into a previously edited note.
- **Debounced Auto-Save Race Condition**: Bound auto-save tasks strictly to the target note ID and flushed pending saves immediately upon switching or creating notes, preventing rapid note transitions from overwriting content across notes.
- **Window Close & Deletion Guard**: Ensured unsaved pending note changes are flushed immediately when closing the notepad window or unmounting, and canceled pending auto-save tasks when a note is deleted.

### 修复
- **便签跨笔记撤销与状态隔离**：修复了 ProseMirror 编辑器历史栈在切换笔记时未清空导致的跨笔记撤销问题。在切换或新建笔记时彻底重置历史状态，防止在当前笔记中按 `Ctrl+Z` 意外撤销回退到上一篇笔记的内容。
- **自动保存防抖并发与覆盖**：将自动保存任务严格绑定至目标笔记 ID，并在切换笔记或新建笔记时立即将上一篇笔记的未存修改冲刷落盘（`flushPendingSave`），彻底消除快速切换笔记时的防抖时间竞争与内容相互覆盖问题。
- **窗口关闭与删除安全保障**：在便签窗口关闭或组件卸载时立即自动存盘未完成的修改；在删除笔记时同步清除对应的待存盘任务，杜绝数据遗留。

## v1.4.5

### Fixed
- **Markdown Formatting on Selection Copy**: Intercepted clipboard `copy` and `cut` events in the notepad editor to write cleanly formatted Markdown to `text/plain` and rich HTML to `text/html`. Pasting selected text into plain-text editors, IDEs, or chat apps now fully preserves list markers (`- `, `1. `), indentation, bold (`**`), strike (`~~`), and headings (`#`).
- **Preserved Sublist Indentation on Deletion**: Upgraded `htmlToMarkdown` to recursively track list nesting depth with proper 2-space indentation. Added smart backspace handling for empty list items: clearing an item like `- 1xxx` when followed by `- 2xxx` deletes the empty item directly rather than hoisting it, keeping `- 2xxx` properly nested under `- Fxxx` at Level 2.
- **Trapped Tab and Handled Indentation**: Intercepted `Tab` and `Shift-Tab` in the editor so focus never escapes to the bottom "Copy All" button. `Tab` now sinks list items to child levels when applicable and inserts 2 spaces in normal text blocks.

### 修复
- **选中复制保留 Markdown 格式**：拦截便签编辑器中的 `copy` 与 `cut` 剪贴板事件，将选中的富文本切片转换为标准 Markdown 写入 `text/plain`，同时保留 `text/html`。复制选中文本后粘贴至代码编辑器、记事本或聊天应用时，列表标记（`- `、`1. `）、层级缩进、加粗（`**`）、删除线（`~~`）与标题（`#`）格式均能完整保留。
- **删除列表项保留子层级缩进**：升级 `htmlToMarkdown`，支持递归列表深度并在每级子列表前添加 2 空格缩进。增加智能退格机制：当退格删除一个空列表项且后续存在同级项时（如 `- 1xxx` 之后紧接 `- 2xxx`），直接移除该空节点，避免因提升父级导致 `- 2xxx` 扁平化，使其继续稳固嵌套在 `- Fxxx` 下方的第二级。
- **拦截 Tab 键并完善缩进**：在编辑器内完全消费 `Tab` 与 `Shift-Tab` 事件，彻底避免焦点意外跳出至底部的“复制全文”按钮；列表项支持按 `Tab` 降级缩进为子项，普通正文按 `Tab` 插入 2 空格缩进。

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

