<h1 align="center">
  <img src="src-tauri/icons/64x64.png" alt="PastePaw 图标" width="40">
  PastePaw
</h1>

<p align="center">面向 Windows 的剪贴板历史与便签工具</p>
<p align="center">保存复制内容，整理便签，按需通过自己的 WebDAV 服务同步。</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="README_EN.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/KiseSaki/PastePaw/actions/workflows/release.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/KiseSaki/PastePaw/release.yml?branch=main&style=flat" alt="构建状态"></a>
  <a href="https://github.com/KiseSaki/PastePaw/releases"><img src="https://img.shields.io/github/v/release/KiseSaki/PastePaw?include_prereleases&style=flat" alt="GitHub 发布版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg?style=flat" alt="GNU GPL v3 许可证"></a>
</p>

> 本仓库基于 [XueshiQiao/PastePaw](https://github.com/XueshiQiao/PastePaw) 修改并持续维护。
>
> 原项目及本 Fork 均按照 GNU GPL v3 许可证发布。
> 本仓库包含自 2026 年起由 KiseSaki 维护的修改内容。
>
> 本分支独立维护 Windows 版本，重点扩展便签编辑、WebDAV 同步与思源集成。
> 本文档于 2026 年 10 月 22 日重写，以说明本分支的功能与使用方式。

[下载安装](https://github.com/KiseSaki/PastePaw/releases) · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/KiseSaki/PastePaw/issues)

## 主要功能

### 剪贴板历史

- 自动记录复制的文本和图片，通过搜索找回历史内容。
- 支持置顶和文件夹分类，整理经常使用的内容。
- 支持键盘选择、数字快捷取用与纯文本粘贴，可在设置中开启自动粘贴。
- 支持自定义呼出快捷键、多显示器定位、深色与浅色主题，以及 Windows Mica 窗口效果。
- 支持忽略指定应用，并可配置历史保留策略。

### 独立便签

- 支持富文本编辑、Markdown 粘贴与复制，以及可嵌套的无序、有序和待办列表。
- 支持标题、引用、代码块、表格、链接、高亮和正文查找替换；可直接粘贴 Excel 表格。
- 支持插入图片、粘贴截图和添加文件附件，附件可另存。
- 支持块移动、复制、拖动与折叠，以及便签的置顶、进行中和已完成分类。

详细操作见[便签编辑器说明](docs/note-editor.md)。

### 可选 WebDAV 同步与思源集成

- 使用自己的 WebDAV 服务，在多台电脑间同步便签、附件及选定额度内的剪贴板历史。
- 支持配置剪贴板条数、图片大小和云端容量；并发编辑时尝试合并独立修改，冲突内容保留供比较与处理。
- 提供思源插件，默认手动单向拉取便签，也可选择手动双向同步已绑定的便签区域。

同步默认关闭。配置方法、服务器要求和功能边界见 [WebDAV 同步说明](docs/webdav-sync.md)与[思源插件说明](siyuan-plugin/README.zh-CN.md)。实际 Windows、安卓思源及个人服务器环境仍需按文档中的验收项验证。

## 界面预览

![PastePaw 界面概览](docs/screenshot_win_panes.png)

<details>
<summary>查看浅色与深色主题</summary>

### 浅色主题

![PastePaw 浅色主题](docs/screenshot_win_light.png)

### 深色主题

![PastePaw 深色主题](docs/screenshot_win_dark.png)

</details>

## 下载与安装

本分支提供 Windows x64 和 ARM64 安装包。

1. 打开[本仓库的 GitHub Releases](https://github.com/KiseSaki/PastePaw/releases)，选择需要安装的版本。
2. 根据电脑架构下载安装包：大多数 Intel / AMD 电脑选择文件名以 `x64-setup.exe` 结尾的安装包；Windows ARM 电脑选择 `arm64-setup.exe`。
3. 运行安装程序，启动后使用默认快捷键 `Ctrl+Shift+V` 呼出剪贴板窗口。

`winget install XueshiQiao.PastePaw` 是上游项目的安装入口。如需使用本分支的便签与同步功能，请使用本仓库 Releases 中的安装包。

发布说明可能附有 VirusTotal 检测链接，可用于查看对应安装包的检测结果。

### 升级

升级前建议备份本地数据。使用同步功能时，还应备份 WebDAV 专用目录和本地加密凭据文件，保存位置见下文及[同步说明](docs/webdav-sync.md)。

本地剪贴板历史、便签和图片默认保存在 `%APPDATA%\PastePaw`。从本分支 v1.4.3 或更早版本升级时，建议先卸载旧版本再安装新版，具体说明见[更新记录](CHANGELOG.md)。

使用便签同步格式 3 时，参与同步的电脑需要 PastePaw 1.6.0 或更新版本；思源插件需要 0.3.0 或更新版本，思源需要 3.8.6 或更新版本。

## 开始使用

1. 复制文本或图片，然后按 `Ctrl+Shift+V` 打开历史记录。
2. 搜索或选择需要的内容，双击卡片或按 `Enter` 将其写入系统剪贴板；开启“自动粘贴”后，会尝试直接粘贴到目标应用。
3. 在剪贴板窗口按 `Ctrl+N` 打开便签，记录待办、整理文字或插入图片。
4. 需要多设备同步时，进入“设置 → WebDAV 同步”，按[同步说明](docs/webdav-sync.md)配置服务并测试连接。

自动粘贴默认关闭，可在设置中开启。能否直接粘贴取决于目标应用对粘贴操作的支持。

### 常用快捷键

全局快捷键默认为 `Ctrl+Shift+V`，可在设置中自定义。下表其余快捷键在对应窗口内使用。

| 使用位置 | 快捷键 | 操作 |
| --- | --- | --- |
| 全局 | `Ctrl+Shift+V` | 显示或隐藏剪贴板窗口 |
| 剪贴板窗口 | `Ctrl+F` | 打开搜索 |
| 剪贴板窗口 | `Ctrl+N` | 打开便签 |
| 剪贴板窗口 | `←` / `→` | 切换选中卡片 |
| 剪贴板窗口 | `Enter` | 取用选中项；未选择时取用第一项 |
| 剪贴板窗口 | `Shift+Enter` | 以纯文本方式取用内容 |
| 剪贴板窗口 | `Ctrl+1` 至 `Ctrl+9` | 取用当前列表中的第 1 至第 9 项 |
| 剪贴板窗口 | `1` 至 `9` | 未聚焦输入框时，取用对应序号的内容 |
| 剪贴板窗口 | `P` | 置顶或取消置顶 |
| 剪贴板窗口 | `Delete` | 删除选中的记录 |
| 剪贴板窗口 | `Esc` | 隐藏窗口 |
| 便签编辑器 | `Ctrl+F` / `Ctrl+H` | 查找 / 替换当前便签正文 |
| 便签编辑器 | `Ctrl+K` | 编辑链接 |
| 便签窗口 | `Ctrl+D` | 切换当前便签的完成状态 |

剪贴板窗口中的左右键、置顶、删除和 `Enter` 取用操作在未聚焦输入框时生效；编辑器内的更多操作见[便签编辑器说明](docs/note-editor.md)。

## 数据与隐私

剪贴板历史与便签的核心功能可离线使用，数据默认保存在本机。启用并解锁 WebDAV 同步后，程序会按配置上传、下载及自动同步数据，因此启用同步时会产生网络请求。

| 数据 | 保存与传输方式 |
| --- | --- |
| 剪贴板历史、便签与图片 | 默认保存在本机；启用同步后，按配置同步到自己的 WebDAV 服务 |
| WebDAV 连接信息 | 在客户端加密保存，使用独立密码解锁 |
| 云端便签、剪贴板与附件 | 未进行端到端加密；传输保护取决于连接方式，HTTPS 校验证书，HTTP 明文传输 |
| 思源插件导入的内容 | 保存到选定思源文档，附件保存到思源工作空间 |

### 忽略指定应用

在设置中找到“忽略的应用”，选择 `.exe` 文件或填写进程名称，例如 `notepad.exe`。也可填写完整可执行文件路径；名称与路径匹配均不区分大小写。

程序会在捕获剪贴板时检查来源应用是否被忽略。配置 WebDAV 或思源插件的连接凭据前，可先暂停剪贴板采集，避免复制账号或密码时进入历史记录。

## 文档与反馈

- [便签编辑器](docs/note-editor.md)：Markdown、列表、表格、块操作和附件。
- [WebDAV 同步](docs/webdav-sync.md)：配置、数据位置、容量、冲突和环境验收。
- [思源插件](siyuan-plugin/README.zh-CN.md)：安装、单向拉取、双向回传和限制。
- [更新记录](CHANGELOG.md)：各版本新增功能、修复与升级说明。
- [问题反馈](https://github.com/KiseSaki/PastePaw/issues)：请附上应用版本、Windows 版本和复现步骤；同步问题可补充脱敏后的错误信息。

## 从源码运行

本项目基于 Rust、Tauri 2、React、TypeScript 和 SQLite 构建，当前分支面向 Windows 开发。

建议使用与发布工作流一致的环境：Node.js 24、pnpm 11.19.0 和 Rust stable，并安装 Windows C++ 构建工具及 WebView2 运行时。Tauri CLI 已包含在项目开发依赖中。

在项目根目录执行：

```powershell
# 安装依赖
pnpm install --frozen-lockfile

# 启动开发环境
pnpm tauri dev
```

构建桌面应用或思源插件：

```powershell
# 构建 Windows 应用
pnpm tauri build

# 构建思源插件
pnpm build:siyuan
```

## 来源、致谢与许可证

感谢 [XueshiQiao](https://github.com/XueshiQiao) 及原项目贡献者提供的 [PastePaw](https://github.com/XueshiQiao/PastePaw)。本分支在原项目基础上修改并独立维护，保留上游版权及许可声明；原有代码和素材的相关权利仍归各自权利人所有，新增贡献的版权归相应贡献者所有。

本仓库以 GNU GPL v3 发布，完整条款见 [LICENSE](LICENSE)。本软件不提供任何担保，详细免责条款以许可证为准。

本分支的 Windows 安装包、问题反馈和发布记录以 [KiseSaki/PastePaw](https://github.com/KiseSaki/PastePaw) 为准。上游的 macOS 版本、官网及赞助渠道由原作者维护。
