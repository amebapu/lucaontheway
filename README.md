# 慢慢长大 · 育儿内容路由

## 速览

- GitHub Pages 托管公开网页，GitHub Actions 定时采集和发布，无需 Cloudflare 账号、数据库或 YouTube API Key。
- 每天北京时间06:17计划更新，也可手动运行；排程可能延迟，以页面显示的采集时间为准。
- 只做内容发现、八主题筛选和原片跳转，不保存实践记录、收藏或用户账号。
- 六个已核验频道通过免费RSS订阅，不需要你的YouTube账号；个别来源失败时仍更新其他来源，全部失败才保留上次网站。
- DeepSeek V4.1 Flash在后台生成中文标题、分类、短概要与关键点；网页访问不调用模型，模型使用AIHub项目额度。没有微信或邮件通知。

## 内容范围

关注12—24个月的语言互动、大运动、精细动作、感官盆、美育、绘本、亲子游戏与早教理论。

`config.json` 订阅 Raising Little Talkers、Pathways、Emma Hubbard、The Artful Parent、MOTHERCOULD 与 Lovevery。Lovevery是品牌频道，含商品介绍，页面会注明。频道身份来自官网直链/频道页面与真实RSS交叉核验；低频来源当前可能没有新片，不把订阅数当成新增数。

每频道读取最多15条最近14天发布的视频，按配置顺序轮流取候选、去重至最多40条，最终按发布时间显示。单个活跃频道最多可保留其15条，不设每源5条硬截断。其他方向继续用八个人工专题入口补充，不承诺每个主题每天都有新视频。

`content.mjs` 排除部分明显面向新生儿、较大儿童或促销的标题，再按标题、简介首行的关键词初筛。规则可能误选或漏选。模型仅阅读标题与公开简介前800字符，未读取字幕或整段视频；中文速览不等于已核实单片适龄、具体操作或医学效果，信息不足会注明。模型主题与原主题合并；相关度低只标注，不自动删除候选。原文可展开，原片链接保留。人工入口的旧文章不会标成今日新增；X目前是手动浏览入口。

## 本地运行

需要Node.js 22以上（推荐24）；AI后台传输使用Python 3.9以上标准库，无额外Python依赖。在本目录执行：

```sh
npm ci --ignore-scripts
npm run collect
npm run enrich
npm run dev
```

打开 [本机预览](http://127.0.0.1:8787/)。`collect` 先生成真实订阅；未提供AI环境变量时，`enrich`复用有效缓存、其余保留原文并注明未启用，不调用模型。`dev`构建并在本机提供静态网页，按Ctrl+C停止。没有采集成功时不会用示例数据凑数。

```sh
npm run check
```

检查覆盖订阅校验、来源公平选取/部分失败、结构化速览、坏响应与超时、缓存失效、中文筛选、秘密白名单和实际构建子路径。测试只使用合成资料；真实采集、模型调用和公网发布分别核验。

## GitHub Pages 发布

本项目使用公开仓库的免费Pages与标准GitHub Actions，无需购买域名。源码和提交历史公开，采集数据与概要缓存不提交Git历史。YouTube订阅无需密钥；AI接入使用下面两个Actions Secrets。

1. 仓库 Settings → Pages → Build and deployment，Source 选 **GitHub Actions**。
2. 推送`main`会自动采集、复用已恢复的概要缓存并发布，未命中项标为“尚未生成速览”；push不读取模型密钥或产生新模型调用。
3. 正常日更由schedule生成新概要。也可由仓库维护者到Actions → **Publish parenting feed** → **Run workflow**，选择`main`，授权手动补跑/验证；浏览器刷新只读取已发布列表。
4. 发布成功后，从`deploy`任务或Pages设置页打开真实网址。网页和数据使用相对路径，适配`/<仓库名>/`项目地址。

工作流使用 UTC `17 22 * * *`，即北京时间次日06:17。网页“刷新内容”只重新读取已发布列表，不会触发一次新采集。

至少一个频道RSS抓取成功即可发布（即使该源没有近期候选也算抓取成功）；失败源本批不带旧条目，并显示“本批未获取”，不是退订或模型删除。全部来源失败才中止发布、保留上次网站和采集时间。页面拒绝展示超过28天的旧列表，旧部署公开元数据在下一次成功部署前仍可能存在。

每批最多40条，每5条一个模型请求、每次最多4096输出token、45秒截止，最多8次，不自动重试。首个模型故障后停止余下请求，保留已成功的新概要/缓存，其余显示原文和“暂不可用”；模型故障不阻断RSS发布。首次或缓存淘汰后可能重新调用，费用以AIHub实际用量为准，不承诺全平台最低价或固定月费。

概要按模型、提示版本与原始标题/简介/日期等指纹复用；原文任何变化均重算，避免复用不当。Actions缓存只保留本批候选、可能淘汰。静态产物仍只有五个文件，不含调用器、配置、缓存、环境、依赖或审稿资料。

GitHub定时任务可能延迟。公开仓库60天无repository activity时会自动停用schedule；官方未完整列举活动范围，也未要求必须人为操作，不能保证采集/发布产物会重置计时。停用后到Actions → **Publish parenting feed** → **Enable workflow**重新启用。不添加无内容保活提交。依据：[排程说明](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows)、[自动停用规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)、[Pages 免费条件](https://docs.github.com/en/pages/getting-started-with-github-pages)。

## AIHub后台配置

在仓库Settings → Secrets and variables → Actions添加Repository Secrets：

- `AIHUB_API_KEY`：获授权使用的AIHub项目调用Key。
- `AIHUB_ENDPOINT`：官方接入工具提供的完整HTTPS Chat Completions请求地址；使用平台实际值，不在公开代码中填写内部地址。

模型请求固定为`deepseek-flash`（DeepSeek V4.1 Flash），关闭思考、使用JSON输出。Key仅进入后台进程环境与Authorization头，不放网页、仓库、URL参数、文件或日志。只有`main`的schedule/手动补跑步骤读取Secrets；PR只测试，push只用缓存。不要在聊天中发送Key。

仓库有写权限的人可修改工作流并使用这些Secrets，因此只向可信协作者开放写权限；使用现有项目Key会使用该项目额度，后续可换为专用小预算Key。网关在GitHub托管runner上的可达性需以真实运行验证；不可达时保留原文更新，不把Key移到浏览器。

## 维护

编辑`config.json`的真实频道ID或`content.mjs`规则，再推送`main`。最多配置8个频道；身份应先核实，不能凭名称猜ID。日更时间、14天采集窗、28天页面过期、八个主题与八个人工专题入口保持既有设置。

使用实测可用的 `https://www.youtube.com/feeds/videos.xml?channel_id=…`，不读取登录账号、Cookie、字幕或视频媒体。`data/`、`dist/`、旧本机运行数据与审稿目录均不提交。此前浏览器记录不会被读取或上传。

Cloudflare Worker、D1配置与开发依赖已移除。共享的`feed.mjs`仅包含浏览器数据校验和筛选；后台采集、AI调用与构建代码位于`scripts/`，不进入网站产物。
