# 慢慢长大 · 育儿内容路由

## 速览

- 网站公开浏览，只做内容发现、主题筛选和原片跳转，不保存实践记录或用户账号。
- 无需 YouTube API Key：读取已核实频道的免费 Atom 订阅，按八主题关键词初筛。
- Cloudflare Worker + D1 + Cron 已准备；当前尚未部署到用户账户，不能把本地测试称为线上日更。
- 配置后的更新时间为北京时间每天约06:17；频道可能没有新片，关键词不等于看完视频或确认适龄。
- DeepSeek 过滤和摘要属于后续方向，本版不调用内容模型，也不向微信或邮箱发送通知。

## 内容范围

关注12—24个月的语言互动、大运动、精细动作、感官盆、美育、绘本、亲子游戏与早教理论。

`config.json` 当前订阅 Raising Little Talkers 和 Pathways 两个真实频道；它们的官网/频道身份及免费 feed 已核实。为控制免费 Worker 的解析开销，第一版最多同时读取两个频道。其他方向先通过八个专题入口补充，不能承诺每个主题每天都有新视频。

频道列表取最近14天发布的视频，每频道最多15条、合计最多30条，按视频ID去重。规则先排除部分明显偏新生儿、较大儿童或促销的标题，再用标题、简介第一行匹配主题；中文搜索也能匹配主题名。规则可能漏选或误选，单片月龄和做法仍需回源核对。

人工精选入口包括 Busy Toddler 的1岁活动与感官盆、The Artful Parent 的幼儿美育、Pathways 的月龄/阅读资料，以及 Harvard 的回应式互动导读。经验分享、机构原文与每日订阅分开展示，旧文章不会被标成今日新推送。

## 本地运行

需要 Node.js 22以上，推荐24。进入本目录：

```sh
npm ci --ignore-scripts
npm run build
npx wrangler d1 execute parenting-lab --local --file schema.sql
npm run dev -- --port 8787 --test-scheduled
```

打开 [本地网页](http://127.0.0.1:8787)。没有采集数据时会如实显示空列表，精选来源仍可浏览。可按 Wrangler 提示触发本地 scheduled 测试；这仅用于验证本地接线，不证明云端 Cron 已运行。开发服务按 Ctrl+C 停止。

## 部署到 Cloudflare

只需一个 Cloudflare 免费账号；网站访客无需注册。可使用 Google 完成 Cloudflare 注册，账号验证与条款确认由账户本人操作。

1. 用官方 Wrangler 授权：`npx wrangler login`，不把凭证贴到聊天或源码。
2. 创建新空库：`npx wrangler d1 create parenting-lab`，把实际返回的数据库ID填入 `wrangler.jsonc`。全零ID是不可部署占位。
3. 仅对这个新空库初始化：`npx wrangler d1 execute parenting-lab --remote --file schema.sql`。
4. 执行 `npm run deploy`。保留实际返回的 `workers.dev` 地址，打开核对页面和 `/api/feed`。
5. 观察首次真实采集与后续 Cron 日志，确认成功时间和视频列表确实更新。默认排程是 UTC `17 22 * * *`，即北京时间次日06:17。

源码可留在指定的私有 GitHub 仓库；网站公开不要求把仓库改成公开。连接 Cloudflare Git 集成时只授权该仓库，构建命令用 `npm run build`，部署命令用 `npm run deploy`。GitHub 工作流仅检查源码，不再下载/导入日报，也无需 YouTube Secret。

本版按免费额度设计，不自动开通收费计划。实际账户额度、Cloudflare到YouTube的可达性、云端CPU和定时执行需部署后验证；本地成功不能替代这些结果。以后若加整站密码/邀请码，需同时保护页面、API与预览地址。

## 更新和维护

编辑 `config.json` 的频道ID、显示名和方向标签后重新部署；必须使用已核对的 `UC…` 频道ID。自动单片分类规则在 `content.mjs`，不会自动翻译视频或生成概要。

使用实测可用的 `https://www.youtube.com/feeds/videos.xml?channel_id=…`。官方 WebSub 文档中的 `/xml/feeds/…` 在本次探测返回非Atom正文，因此没有把它当成空频道，也没有添加不受控的重定向或猜测回退。

所有频道本轮成功才原子替换列表；任一失败保留28天内上次结果，成功时间不前移。28天后停止返回旧元数据并尝试清理；长期失效的频道需要维护者替换。缓存不写入Git历史或静态资源，网页没有公开的写入/采集触发接口。

已删除被免费订阅替代的 `collect.py`、`test_collect.py`、`serve.py` 和旧的 `discover.yml`；新版无需实践本、收藏、导出或邮箱准入。此前浏览器中的本地记录没有被读取、上传或删除。旧原型ZIP只作为本地回退，不放进部署包。

## 验证

```sh
npm run check
```

检查覆盖 Atom格式、频道/时间校验、实体和大小限制、主题规则、重试边界、真实本地D1并发锁与过期清理、失败保留、静态资源边界和本地scheduled接线。测试使用合成资料；真实频道探测、本地浏览器验证和云端验证须分别记录。
