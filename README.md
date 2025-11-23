# Flymd Halo Publisher

一个面向 Flymd 的外置插件，用来把当前文档发布到 [Halo](https://github.com/halo-dev/halo) 并保持与远端同步。

## 功能

- 通过菜单快速发布当前文档到任意 Halo 站点
- 支持默认站点一键发布、或手动选择站点
- 从 Halo 拉取文章内容并覆盖当前文档
- 自动同步 Front Matter 中的 `title/slug/cover/excerpt/categories/tags/halo` 信息
- 菜单内内置设置入口，直接在 Flymd 内管理站点和发布策略

## 安装

1. 将 `manifest.json` 与 `main.js` 上传到任意可访问的地址（GitHub 仓库或者 HTTP 服务），保持两者在根目录。
2. 在 Flymd「扩展」面板中输入仓库地址或 manifest URL 进行安装。
3. 启用插件后，菜单栏会出现 `Halo 发布` 项。

## 配置步骤

1. 打开菜单 `Halo 发布 -> 配置站点`，通过弹出的交互式提示逐步添加站点信息：
   - **站点名称**：仅用于区分显示，可为空。
   - **站点地址**：Halo 面板地址（例如 `https://example.com`）。
   - **Token**：Halo 后台生成的 Personal Access Token，至少需要 `Post Manage` 权限。
2. 可添加多个站点，并设置一个默认站点用于快速发布。
3. 在配置面板中可以切换「默认发布行为」（默认自动发布，可改为保留草稿）。

所有配置均存储在插件私有的 `context.storage` 中，不会污染原文档。

## 使用方式

- **发布到 Halo**：选择 `发布到 Halo` 菜单项后，插件会根据 Front Matter 中的 `halo.site` 来自动匹配站点；如果为空则弹出选择框。
- **默认站点快速发布**：直接使用配置中标记的默认站点，无需再次选择。
- **更新当前文档**：当文档已经包含 `halo.site` 与 `halo.name` 时，可从远端拉取最新内容覆盖本地。
- **Front Matter**：发布成功后会写入以下字段，供后续更新使用：
  ```yaml
  title: 文章标题
  slug:  url slug
  categories:
    - 分类 A
  tags:
    - 标签 A
  halo:
    site: https://example.com
    name: 资源名
    publish: true
  ```

## 渲染说明

Halo 接口要求同时提供 Markdown 原文与 HTML 内容。插件会优先尝试从 [jsDelivr](https://cdn.jsdelivr.net/) 动态加载 `marked` 库来完成 Markdown 渲染；如果网络受限，则退回到内置的简易渲染器，保证仍能发布成功。为获得更好的渲染效果，建议在联网环境下使用。

## 已知限制

- 插件目前通过 `prompt/alert` 交互管理站点，后续可根据 Flymd 的 UI 能力替换为更友好的面板。
- 简易 YAML 解析仅覆盖常见 Front Matter 写法（键值、嵌套对象与列表）；复杂 YAML 语法暂不支持。

欢迎在完成自测后将该插件发布到 GitHub 或其它可访问的文件服务，方便在 Flymd 中通过 manifest 地址安装。
