# 慢慢长大 · 育儿内容路由

## 速览

- GitHub Pages 托管公开网页，GitHub Actions 定时采集和发布，无需 Cloudflare 账号、数据库或 YouTube API Key。
- 每天北京时间06:17计划更新，也可手动运行；排程可能延迟，以页面显示的采集时间为准。
- 只做内容发现、八主题筛选和原片跳转，不保存实践记录、收藏或用户账号。
- 十个已核验频道通过免费RSS订阅，不需要你的YouTube账号；另有人工精选阅读入口。个别来源失败时仍更新其他来源，全部失败才保留上次网站。
- DeepSeek V4.1 Flash在后台生成中文速览；可选接入Supadata原生字幕，提炼带原片时间点的玩法笔记。未配置字幕密钥时仍依据标题与简介。网页访问不调用模型，没有微信或邮件通知。

## 内容范围

关注12—24个月的语言互动、大运动、精细动作、感官盆、美育、绘本、亲子游戏与早教理论。

`config.json` 订阅 Raising Little Talkers、Pathways、Emma Hubbard、The Artful Parent、MOTHERCOULD、Lovevery、Teach Me To Talk、ZERO TO THREE、The Hanen Centre 与 Dr. Lauren Baker。Lovevery含品牌商品，Teach Me To Talk含课程介绍，ZERO TO THREE含政策内容；Hanen、Dr. Lauren Baker更新较少。频道身份来自官网直链/频道页面与真实RSS交叉核验；不把订阅数当成新增数，单片仍需核对年龄与内容。

每频道读取最多15条最近14天发布的视频，按配置顺序轮流取候选、去重至最多40条，最终按发布时间显示。单个活跃频道最多可保留其15条，不设每源5条硬截断。八个人工专题入口之外，补充ZERO TO THREE的12—24月游戏指南、The Montessori Notebook、The OT Toolbox、Toddler Approved和Vroom；都是手动阅读入口，不伪装每日自动采集。不承诺每个主题每天都有新视频。

`content.mjs` 排除部分明显面向新生儿、较大儿童或促销的标题，再按标题、简介首行的关键词初筛。规则可能误选或漏选。没有可用字幕时，模型仅阅读标题与公开简介前800字符；有字幕时明确显示字幕语言、完整轨或已读时间范围。两种依据分别计数，均未看画面，也未经人工安全审阅。具体月龄、做法与风险请看原片核对，信息不足会注明。模型主题与原主题合并；相关度低只标注，不自动删除候选。原文可展开，原片链接保留。人工入口的旧文章不会标成今日新增；X目前是手动浏览入口，未开通付费API。

## 本地运行

需要Node.js 22以上（推荐24）；AI后台传输使用Python 3.9以上标准库，无额外Python依赖。在本目录执行：

```sh
npm ci --ignore-scripts
npm run collect
npm run captions
npm run enrich
npm run dev
```

打开 [本机预览](http://127.0.0.1:8787/)。`collect` 先生成真实订阅；`captions`在未提供字幕密钥时不请求服务。未提供AI环境变量时，`enrich`复用有效缓存、其余保留原文并注明未启用，不调用模型。两个后台命令均支持`--cache-only`，只复用缓存。`dev`构建并在本机提供静态网页，按Ctrl+C停止。没有采集成功时不会用示例数据凑数。

```sh
npm run check
```

检查覆盖订阅校验、来源公平选取/部分失败、字幕毫秒换算/头中尾选段/时间点证据、结构化速览、坏响应与超时、缓存失效、中文筛选、公开字段白名单和实际构建子路径。测试只使用合成资料；真实采集、模型调用和公网发布分别核验。

## GitHub Pages 发布

本项目使用公开仓库的免费Pages与标准GitHub Actions，无需购买域名。源码和提交历史公开，采集数据与缓存不提交Git历史。YouTube RSS无需密钥；模型和可选字幕服务各用一个Actions Secret。

1. 仓库 Settings → Pages → Build and deployment，Source 选 **GitHub Actions**。
2. 推送`main`会自动采集、复用已恢复的字幕和概要缓存并发布，未命中项保留原文；push不读取服务密钥或产生新字幕/模型调用。
3. 正常日更由schedule生成新概要。也可由仓库维护者到Actions → **Publish parenting feed** → **Run workflow**，选择`main`，授权手动补跑/验证；浏览器刷新只读取已发布列表。
4. 发布成功后，从`deploy`任务或Pages设置页打开真实网址。网页和数据使用相对路径，适配`/<仓库名>/`项目地址。

工作流使用 UTC `17 22 * * *`，即北京时间次日06:17。网页“刷新内容”只重新读取已发布列表，不会触发一次新采集。

页面分别显示本站更新时间（本批静态页面生成时刻，GitHub部署完成后才对外生效）、本批采集时间和每条作者原始发布时间，有概要时显示概要生成时间，统一使用北京时间并精确到秒。命中缓存的概要保留原生成时间，不会用本站更新时刻覆盖作者日期或概要日期。

至少一个频道RSS抓取成功即可发布（即使该源没有近期候选也算抓取成功）；失败源本批不带旧条目，并显示“本批未获取”，不是退订或模型删除。全部来源失败才中止发布、保留上次网站和采集时间。页面拒绝展示超过28天的旧列表，旧部署公开元数据在下一次成功部署前仍可能存在。

采集失败的诊断日志只记录HTTP状态码或固定网络错误类型，不输出请求URL、头、正文、密钥或原始错误信息；已有重试与截止时间不变。

每批最多40条，元数据每5条一个模型请求，字幕每条单独请求且最多3次；合计最多8次，每次最多4096输出token、45秒截止，整个概要阶段365秒，不自动重试。无缓存且3条字幕请求全成功时，最多覆盖3+5×5=28条，其余本次显示原文；下次有效缓存可继续补齐，内容持续变化时不保证全部覆盖。首个模型故障后停止余下请求，保留已成功的新概要/缓存；字幕升级失败时仍保留有效的元数据概要，升级成功后仅缓存字幕概要。模型故障不阻断RSS发布。首次或缓存淘汰后可能重新调用，用量以TokenHub套餐统计为准，不承诺全平台最低价或固定月费。

概要按模型、提示版本与原始标题/简介/日期等指纹复用；字幕概要另包含实际语言、范围和片段内容，旧元数据指纹不变。Actions缓存只保留本批候选、可能淘汰；两个缓存文件分别限制为1MiB。静态产物仍只有五个文件，不含调用器、配置、缓存、环境、依赖或审稿资料。

GitHub定时任务可能延迟。公开仓库60天无repository activity时会自动停用schedule；官方未完整列举活动范围，也未要求必须人为操作，不能保证采集/发布产物会重置计时。停用后到Actions → **Publish parenting feed** → **Enable workflow**重新启用。不添加无内容保活提交。依据：[排程说明](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows)、[自动停用规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)、[Pages 免费条件](https://docs.github.com/en/pages/getting-started-with-github-pages)。

## TokenHub后台配置

在仓库Settings → Secrets and variables → Actions添加Repository Secret：

- `TOKENHUB_API_KEY`：获授权使用的TokenHub个人套餐Key。

模型请求固定为`deepseek/deepseek-flash`（官方当前映射为DeepSeek V4.1 Flash 1017），关闭思考、使用JSON输出。后端固定请求`https://tokenhub.tencentmaas.com/plan/v3/chat/completions`，不读取环境中的端点覆盖值，也不回退到按量计费接口。Key仅进入后台进程环境与Authorization头，不放网页、仓库、URL参数、文件或日志。只有`main`的schedule/手动补跑步骤读取Secret；PR只测试，push只用缓存。不要在聊天中发送Key。

Token Plan个人版官方规则限制自动化脚本、自定义应用后端和非交互式批量调用；本项目按所有者明确选择使用个人套餐接口，不代表服务商批准此用途。若服务拒绝、额度耗尽或暂停，保留原文更新，不伪装客户端、绕过限制或改用其他计费产品。参见[个人版订阅须知](https://cloud.tencent.com/document/product/1823/130060)、[个人版接入配置](https://cloud.tencent.com/document/product/1823/130119)和[模型版本公告](https://cloud.tencent.com/announce/detail/2516)。

仓库有写权限的人可修改工作流并使用该Secret，因此只向可信协作者开放写权限。GitHub托管runner上的实际接通需单独验证；不可达时保留原文更新，不把Key移到浏览器。旧AIHub Secrets不再被本工作流引用。

## 可选字幕配置

需要所有者自行选择并注册[Supadata免费账号](https://dash.supadata.ai/)，确认该服务的条款，再将API Key保存为仓库Actions Secret **`SUPADATA_API_KEY`**。不要发到聊天或写入代码。未配置时不请求服务；正常排程/手动补跑的未命中项显示“字幕尚未接通”，push只用缓存，未命中项显示“本次未读取字幕”。准备代码不代表已注册或验证真实字幕。

服务[当前免费额度](https://supadata.ai/pricing)为每月100 credits，已有字幕每次1 credit。后台固定请求公开`https://api.supadata.ai/v1/transcript`，只发送由视频ID构造的YouTube链接，使用`mode=native`、`text=false`、`lang=en`（优先语言，页面以实际返回语言为准）和`chunkSize=500`；Key仅在`x-api-key`头里。不使用生成转录、自动模式、翻译或付费加购，不读取YouTube登录、Cookie、音视频或代理配置。YouTube官方字幕下载需要视频编辑权限，普通观看账号不能解决任意公开视频的字幕授权问题。

每次正常排程/手动补跑最多3次字幕获取，优先较完整的简介与亲子游戏候选，再按新近程度选择；缓存命中不消耗请求。不代表每月硬封顶：手动多跑也占额度，不保证每次成功均有可用字幕。遇鉴权、额度、网络或响应格式故障立即停止本轮后续获取；暂无字幕或待处理缓存24小时，不轮询后台任务。单请求23秒、整个字幕阶段75秒；服务失败继续使用已有概要或标题与简介。排程、依赖和缓存耗时还受GitHub平台影响，构建任务总截止10分钟。

字幕先校验时间戳（服务毫秒转为秒），限制4小时、每条1000字符；小轨全部读入，长轨取头/中/尾，最多300条、序列化UTF-8不超过12KiB。实际完整模型请求仍限制24KiB，必要时缩小片段，放不下则退回元数据。页面显示实际已读区间；片段没有说明不能推断整段原片也没说明。

玩法笔记只保留字幕有连续原文证据的月龄、最多3条材料、4条按原序的步骤和3条注意事项，时间点由已读字幕生成，模型不能自填链接；原文引用仅用于后台匹配，不公开。证据不匹配时舍弃该份玩法笔记，仍可保留有效的普通字幕概要。未明确月龄不把“toddler”换算为12—24个月；低相关、其他年龄、诊疗或商品内容不改写成适龄玩法。字幕可能有识别错误，原文匹配也不能证明中文释义或做法正确，不等于已看过画面。

有效字幕快照最多复用28天，不因超过7天而把仍在候选中的字幕卡降级。常规新采集仍只选最近14天发布的条目；28天是旧部署/快照的最长有效期，不是保留旧候选的承诺。字幕片段只存后台`data/captions-cache.json`与Actions缓存，不进Git历史或Pages；公开仓库的Actions缓存不是机密存储，分支/PR读者可能访问基础分支缓存，不得存入秘密或个人内容。PR工作流本身不恢复缓存或读取Secrets。字幕作者权利仍归创作者，服务可返回文本不等于授予任意转载权。

## 维护

编辑`config.json`的真实频道ID或`content.mjs`规则，再推送`main`。最多配置10个频道；身份应先核实，不能凭名称猜ID。日更时间、14天采集窗、28天页面过期、八个主题与八个人工专题入口保持既有设置。

RSS使用实测可用的 `https://www.youtube.com/feeds/videos.xml?channel_id=…`；可选字幕独立按上节配置。`data/`、`dist/`、旧本机运行数据与审稿目录均不提交。此前浏览器记录不会被读取或上传。

Cloudflare Worker、D1配置与开发依赖已移除。共享的`feed.mjs`仅包含浏览器数据校验和筛选；后台采集、AI调用与构建代码位于`scripts/`，不进入网站产物。
