# 中国节假日日历订阅

把「云日历」App 的法定节假日、调休、农历节日、二十四节气，转换成 iPhone / iPad / Mac 可直接订阅的 `.ics` 日历。

数据每天由 GitHub Actions 自动重新生成，订阅一次长期有效。

## 订阅地址

| 日历 | 地址 | 说明 |
|---|---|---|
| 完整版 | `https://j0vand.github.io/china-holiday-ics/china-all.ics` | 节假日 + 调休 + 全部节日 + 节气 |
| 仅法定节假日 | `https://j0vand.github.io/china-holiday-ics/china-holidays.ics` | 放假、补班，最清爽 |
| 仅节日 | `https://j0vand.github.io/china-holiday-ics/china-festivals.ics` | 公历/农历节日、二十四节气 |

## 在苹果设备上订阅

**iPhone / iPad**

设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅的日历 → 粘贴地址 → 存储

**Mac**

日历 App → 文件 → 新建日历订阅 → 粘贴地址

订阅时建议把「移除」设为「从不」，否则过期事件会被清掉。

## 数据来源

全部来自云日历（青岛软媒）的公开接口，无需鉴权：

- 法定节假日 + 调休：`https://mtapi.ruanmei.com/api/calendar/getholiday?year={年}`
- 节日库：`https://mtapi.ruanmei.com/api/calendar/getfestivalinfo`

农历换算复用云日历自带的 `SolarLunar.js`（1891–2100），保证日期与 App 内一致。

### 关于年份覆盖

官方接口目前只提供 **2025–2027**，更早年份已从服务端下线。2024 及以前的数据取自云日历 App 的本地缓存，固化在 `data/fallback-holidays.json`。2028 及以后要等国务院公布、服务端更新后才会自动出现。

## 本地运行

```bash
node gen.js              # 生成到 docs/
node gen.js --serve 8787 # 生成后启动本地 HTTP 服务，供局域网设备订阅
```

依赖只有 Node 18+ 自带的 `fetch`，无需 npm install。

## 目录说明

```
gen.js                        生成器
lib/SolarLunar.js             农历/节气换算（来自云日历）
images/terms.json             二十四节气数据
data/fallback-holidays.json   历史年份兜底数据
data/raw-*.json               接口原始响应留档
docs/*.ics                     生成的订阅文件
```

## 事件样式

| 标题 | 含义 |
|---|---|
| `🎉 春节（9天）` | 假期首日，括号内为连休天数 |
| `🏖 放假` | 假期中的其余日子 |
| `⚠️ 调休上班（补班）` | 需要补班的周末，标记为忙碌 |
| `★ 中秋节` | 重点节日（带星标） |

放假事件用 `TRANSP:TRANSPARENT`（不占用忙碌时间），补班用 `TRANSP:OPAQUE`，不会干扰会议安排。

## 曾经用过的第三方订阅（备查，想换回去时用）

下面两个是我做这套之前订阅的，来自第三方项目，内容没本项目的全，但轻量稳定。留在这里方便随时换回去。

| 日历 | 地址 | 来源 |
|---|---|---|
| 中国节假日 | `https://cdn.jsdelivr.net/npm/chinese-days/dist/holidays.ics` | [vsme/chinese-days](https://github.com/vsme/chinese-days)（NPM 包 `chinese-days`，经 jsDelivr CDN 分发） |
| 中国节气 | `https://cal.bboy.app/custom.ics?feeds=festival` | [bboysoul](https://cal.bboy.app/) 提供的免费订阅服务 |

两个都是第三方公开服务，无需账号。

`cal.bboy.app` 的 `feeds` 参数可以自由组合，可选值：`holiday`（法定节假日+补班）、`festival`（节日节气）、`almanac`（老黄历）、`weather`（天气）、`horoscope`（星座）、`movies`、`sports`、`stock`。比如想用一个订阅同时覆盖节假日和节日：

```
https://cal.bboy.app/custom.ics?feeds=holiday,festival
```

### 与本文档订阅的差别

| | 本项目 | chinese-days | cal.bboy.app |
|---|---|---|---|
| 覆盖年份 | 2022–2027 | 2025–2027 | 2026–2027 |
| 法定节假日 + 调休 | ✅ 218 事件 | ✅ 38 事件 | ✅ 73 事件（`feeds=holiday`） |
| 农历节日 | ✅ 13 个（含除夕、南北小年） | ❌ | ✅ 多数，但缺除夕 |
| 二十四节气 | ✅ | ❌ | ✅ 100 事件（`feeds=festival`） |
| 假期首日标注连休天数 | ✅ | ❌ | ❌ |
| 补班日标注「哪个节前」 | ❌ | ❌ | ✅（如「补班工作日（春节前）」） |
| 自动更新 | GitHub Actions 每日 | 项目发版后 CDN 更新 | 服务端自动 |

`chinese-days` 那份只有「休 / 班」两种标记（如 `元旦（休）`、`春节（班）`），够用但信息少；`cal.bboy.app` 按 `feeds` 拆分，节日、节气、黄历、天气各是一个 feed，要哪块选哪块。

### 换回去

1. 日历 App 里删掉本项目订阅（iPhone：设置 → 日历 → 账户 → 对应订阅 → 删除账户）
2. 按上面「在苹果设备上订阅」的步骤添加旧地址即可

原来那两个是分开订的（一个节假日、一个节气），也可以只订 `cal.bboy.app` 的 `feeds=holiday,festival` 一个搞定。
