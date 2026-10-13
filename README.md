# 简繁切换 · TextSwitch

一个无需联网的 Chrome 扩展。选中中文后，在浮窗中转换简体或繁体，预览并复制结果；选区位于输入框中时，还可以直接替换选中的部分。

## 安装

扩展已经包含转换词库，**使用时无需安装 Node.js 或运行构建命令**。

1. 在 Chrome 地址栏打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本项目的 **`extension`** 目录（不是项目根目录）。
3. 刷新已打开的网页。可以在扩展菜单中将「简繁切换」固定到工具栏。

也可从 [GitHub 发布页](https://github.com/Lizjunn/TextSwitch/releases/latest)下载 `TextSwitch-1.0.2.zip`，解压后加载包含 `manifest.json` 的目录。

### 更新已有扩展

如果加载的是本项目的 `extension` 目录，更新代码后打开 `chrome://extensions`，点击「简繁切换」卡片上的重新加载按钮，再刷新需要使用的网页。如果使用的是其他目录中解压的旧包，请用新版压缩包覆盖该目录的扩展文件，再重新加载扩展并刷新网页。

## 使用

- **网页文字：**选中中文 → 转简体 / 转繁体 → 复制结果。
- **输入框：**选中中文 → 转换并核对预览 → 替换选中文字 / 复制结果。替换保留选区前后的内容。
- **右键菜单：**选中文字后右键，选择转换方向。关闭自动浮窗后仍可使用。普通网页保留转换入口，兼容浏览器未识别组件选区的情况；未选中中文时会提示先选择文字。
- **工具栏面板：**自动读取网页选区，也可粘贴任意文字转换；输入框选区支持从面板替换。手动改写原文后不再提供对原输入框的替换。
- **偏好设置：**自动浮窗开关，以及通用繁体、台湾字形、香港字形。地区选项只调整字形，不额外改写地区用词。
- **关闭与撤销：**Esc、浮窗关闭按钮或点击页面其他位置可关闭浮窗；页面自行清空选区或滚动不会立即关闭已打开的转换结果。Chrome 标准编辑操作支持 Ctrl+Z 撤销替换。

打开 `demo/index.html` 可以体验普通文字、单行输入框、多行文本域和富文本编辑区。本地文件需要在扩展详情中开启「允许访问文件网址」；也可在项目目录运行 `npx http-server .` 后访问体验页。

## 支持与限制

支持普通 `input`（text / search / url / tel）、`textarea`、标准 `contenteditable`、可访问的网页 iframe，以及 Shadow DOM 组件内的文字和标准输入框。可利用 Chrome 扩展接口读取开放或封闭组件，无法获得精确选区时仍提供转换与复制。密码字段不处理，只读字段只提供复制。文字或编辑目标发生变化时，会阻止旧选区替换，避免覆盖新内容。

Chrome 内置页面、Chrome 网上应用店和内置 PDF 阅读器不允许普通内容脚本运行，请将文字粘贴到工具栏面板。部分自定义编辑器、画布编辑器与复杂富文本应用可能不支持直接替换，可复制结果后粘贴。富文本替换按纯文本插入，选区内样式可能变化，选区外的格式保留。简繁转换无法消除所有词义歧义，请核对预览结果。

## 隐私与权限

不请求网络服务、不上传文字、不保存转换历史。词库和代码均随扩展打包。

| 权限 | 用途 |
| --- | --- |
| 匹配普通 HTTP / HTTPS / 文件页面的内容脚本 | 检测选区、显示浮窗和替换所选文字 |
| `contextMenus` | 添加简繁转换右键菜单 |
| `clipboardWrite` | 复制转换结果 |
| `storage` | 保存偏好，以及会话中的选区所在 frame 编号；不保存原文 |
| `activeTab` | 从工具栏面板连接当前网页 |

## 开发与验证

```powershell
npm ci
npx playwright install chromium
npm test
npm run package
```

`npm ci` 会将固定版本的 OpenCC 词库与完整授权文件复制到 `extension/vendor`。业务脚本为原生 JavaScript，不需要额外构建。图标可通过 `scripts/icons.ps1` 在 Windows 上重新生成。

测试覆盖词语歧义、混合简繁、地区字形、换行和 Unicode，以及真实 Chromium 扩展中的局部替换、撤销、富文本、只读 / 密码字段、剪贴板、过期选区保护、iframe、嵌套 Shadow DOM、右键命令路由、面板通信、偏好保存、窄屏布局、平滑滚动和选区被清空时的浮窗保留。浏览器测试的截图位于 `artifacts/`。

1.0.2 修复了组件内真实鼠标选中文字后，浏览器仍把外层选区报告为空而导致浮窗缺失的问题，并保留右键菜单入口。已在用户提供的订单保存网页 4 处文字、指定 B 站视频的 3 处已发布评论及回复上，通过真实鼠标拖选验证自动浮窗、转换、复制和右键转换消息处理；右键消息验证没有自动点击浏览器原生菜单项。另有 8 项单元测试和 36 项浏览器测试覆盖回归。

组件选区读取参考 [Shadow DOM 选区文档](https://developer.mozilla.org/en-US/docs/Web/API/Selection/getComposedRanges)和 [Chrome 组件访问接口](https://developer.chrome.com/docs/extensions/reference/api/dom)。顶层浮窗参考 [Popover 文档](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/showPopover)。

采用 [opencc-js](https://github.com/nk2028/opencc-js) 1.4.2（代码 MIT，字典数据 Apache-2.0），原始第三方授权及声明保留在 `extension/vendor/`。扩展结构参考 [Chrome 内容脚本文档](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)与[右键菜单文档](https://developer.chrome.com/docs/extensions/reference/api/contextMenus)。
