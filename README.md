# 慢慢长大 · 育儿内容路由

## 速览

- GitHub Pages 托管公开网页，GitHub Actions 定时采集和发布，无需 Cloudflare 账号、数据库或 YouTube API Key。
- 每天北京时间06:17计划更新，也可手动运行；排程可能延迟，以页面显示的采集时间为准。
- 只做内容发现、八主题筛选和原片跳转，不保存实践记录、收藏或用户账号。
- 采集失败不会发布新版本，保留上次网站；页面拒绝展示超过28天的旧列表。
- 模型过滤、翻译和摘要属于后续方向，本版不调用内容模型，也不发微信或邮件通知。

## 内容范围

关注12—24个月的语言互动、大运动、精细动作、感官盆、美育、绘本、亲子游戏与早教理论。

`config.json` 首批订阅 Raising Little Talkers 和 Pathways 两个已核实频道，每频道最多15条最近14天发布的视频，合计最多30条并去重。其他方向通过八个有人工标签的专题入口补充，不承诺每个主题每天都有新视频。

`content.mjs` 排除部分明显面向新生儿、较大儿童或促销的标题，再按标题、简介首行的关键词分类。规则可能误选或漏选，不等于看完原片或确认具体做法适龄。人工入口包含 Busy Toddler、The Artful Parent、Pathways 与 Harvard 原文；旧文章不会标成今日新增。X 目前是手动浏览入口。

## 本地运行

需要 Node.js 22以上，推荐24。在本目录执行：

```sh
npm ci --ignore-scripts
npm run collect
npm run dev
```

打开 [本机预览](http://127.0.0.1:8787/)。`collect` 先生成真实订阅，`dev` 构建后仅在本机提供静态网页，按 Ctrl+C 停止。没有采集成功时不会用示例数据凑数。

```sh
npm run check
```

检查覆盖订阅格式、频道/时间校验、大小和实体限制、重试、八主题规则、采集失败保留、构建白名单和项目子路径资源。测试只使用合成资料；真实采集与公网发布需要分别核验。

## GitHub Pages 发布

本项目使用公开仓库的免费 Pages 与标准 GitHub Actions。无需购买域名或添加密钥。源码和提交历史公开，但采集数据不提交到 Git 历史。

1. 仓库 Settings → Pages → Build and deployment，Source 选 **GitHub Actions**。
2. 推送 `main` 会自动采集并发布。也可以到 Actions → **Publish parenting feed** → **Run workflow** 手动更新。
3. 发布成功后，从 `deploy` 任务或 Pages 设置页打开真实网址。网页和数据使用相对路径，适配 `/<仓库名>/` 项目地址。

工作流使用 UTC `17 22 * * *`，即北京时间次日06:17。网页“刷新内容”只重新读取已发布列表，不会触发一次新采集。

全部频道成功后才生成新文件、构建并部署；任一频道失败会中止发布，保留上次 Pages 网站和采集时间。超28天后页面停止展示旧列表，旧部署中的公开元数据在下一次成功部署前仍可能存在。静态文件只包含网页、样式、浏览器模块和当前订阅，不包含配置源码、依赖、审稿资料或旧原型ZIP。

GitHub 定时任务可能延迟；公开仓库60天没有活动时，排程会自动停用，届时需在 Actions 重新启用。依据：[排程说明](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows)、[自动停用规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)、[Pages 免费条件](https://docs.github.com/en/pages/getting-started-with-github-pages)。

## 维护

编辑 `config.json` 的真实频道ID或 `content.mjs` 的规则，再推送 `main`。当前最多配置两个频道；频道身份应先核实，不能只凭名称猜ID。

使用实测可用的 `https://www.youtube.com/feeds/videos.xml?channel_id=…`，不读取登录账号、Cookie、字幕或视频媒体。`data/`、`dist/`、旧本机运行数据与审稿目录均不提交。此前浏览器记录不会被读取或上传。

已停用并移除本项目不再需要的 Cloudflare Worker、D1 配置及其开发依赖。以后接模型时，密钥应放 GitHub Actions Secrets，不能写进网页或公开仓库。
