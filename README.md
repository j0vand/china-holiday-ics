# 中国节假日日历订阅

把「云日历」App 的法定节假日、调休、农历节日、二十四节气，转换成 iPhone / iPad / Mac 可直接订阅的 `.ics` 日历。

数据每天由 GitHub Actions 自动重新生成，订阅一次长期有效。

## 订阅地址

部署到 GitHub Pages 后：

| 日历 | 地址 | 说明 |
|---|---|---|
| 完整版 | `https://<用户名>.github.io/<仓库名>/china-all.ics` | 节假日 + 调休 + 全部节日 + 节气 |
| 仅法定节假日 | `https://<用户名>.github.io/<仓库名>/china-holidays.ics` | 放假、补班，最清爽 |
| 仅节日 | `https://<用户名>.github.io/<仓库名>/china-festivals.ics` | 公历/农历节日、二十四节气 |

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
node gen.js              # 生成到 out/
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
out/*.ics                     生成的订阅文件
```

## 事件样式

| 标题 | 含义 |
|---|---|
| `🎉 春节（9天）` | 假期首日，括号内为连休天数 |
| `🏖 放假` | 假期中的其余日子 |
| `⚠️ 调休上班（补班）` | 需要补班的周末，标记为忙碌 |
| `★ 中秋节` | 重点节日（带星标） |

放假事件用 `TRANSP:TRANSPARENT`（不占用忙碌时间），补班用 `TRANSP:OPAQUE`，不会干扰会议安排。
