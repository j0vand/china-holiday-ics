#!/usr/bin/env node
/**
 * 中国节假日 ICS 订阅生成器
 * 数据来源：云日历（软媒）公开接口
 *   - 法定节假日/调休：https://mtapi.ruanmei.com/api/calendar/getholiday?year=YYYY
 *   - 节日库（公历/农历/某月第几个周几）：https://mtapi.ruanmei.com/api/calendar/getfestivalinfo
 * 农历换算：复用云日历自带的 SolarLunar 模块（1891-2100）
 *
 * 输出：
 *   out/china-holidays.ics  法定节假日 + 调休补班（推荐订阅这个）
 *   out/china-festivals.ics 公历 + 农历 + 节日（可选）
 *   out/china-all.ics       上面全部合并
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const OUT_DIR = path.join(__dirname, 'docs');
const DATA_DIR = path.join(__dirname, 'data');
const BASE = 'https://mtapi.ruanmei.com/api/calendar';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
// 云日历应用本地缓存（含官方接口已下线的历史年份）
const APP_STORE =
  process.env.YUNRILI_STORE ||
  path.join(
    process.env.HOME,
    'Library/Application Support/mytime/config.json'
  );

// ---------- 农历模块加载（它 require 了 electron-store / moment，需要打桩） ----------
function loadSolarLunar() {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron-store') return class Store { get() {} set() {} };
    if (request === 'electron') return { remote: { getGlobal: () => ({}) } };
    // 农历模块依赖应用内的 MTStore（只在 getWeekNumber 里用到），这里给个空壳
    if (request === './MTStore') return { getSetPropsValue: (k, def) => def };
    // moment 同理，仅 getWeekNumber 使用，本脚本不调用该函数
    if (request === 'moment') {
      const stub = () => ({ isMoment: () => false });
      stub.isMoment = () => false;
      return stub;
    }
    return origLoad.apply(this, arguments);
  };
  try {
    return require(path.join(__dirname, 'lib', 'SolarLunar.js'));
  } finally {
    Module._load = origLoad;
  }
}
const lunar = loadSolarLunar();

// ---------- 工具 ----------
const pad = (n, len = 2) => String(n).padStart(len, '0');

/** 日期 key 形如 "d0101" -> 数字 yyyymmdd */
function keyToYmd(key) {
  return Number(key.slice(1, 3)) * 100 + Number(key.slice(3));
}

/** Date -> "YYYYMMDD" */
function fmtDate(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Date -> "YYYYMMDDTHHMMSS"（本地时间，ICS 里配 TZID 用） */
function fmtDT(d) {
  return (
    fmtDate(d) + 'T' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  );
}

/** Date -> "YYYY-MM-DD" */
function fmtISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 把 "YYYY-MM-DD" 之类的字符串变成 Date（本地零点） */
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

// ---------- ICS 基本构件 ----------
function escapeText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** 按 RFC5545 每 75 字节折行（按 UTF-8 字节，不能切断多字节字符） */
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = [];
  let curLen = 0;
  let limit = 75;
  for (const ch of line) {
    const chLen = Buffer.byteLength(ch, 'utf8');
    if (curLen + chLen > limit) {
      out.push(cur.join(''));
      cur = [];
      curLen = 0;
      limit = 74; // 续行前面要加一个空格，占 1 字节
    }
    cur.push(ch);
    curLen += chLen;
  }
  if (cur.length) out.push(cur.join(''));
  return out.join('\r\n ');
}

function icsHeader(name, desc, tzid) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//China Holiday ICS//Yunrili Data//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    `X-WR-CALDESC:${escapeText(desc)}`,
    `X-WR-TIMEZONE:${tzid}`,
    // 苹果日历会参考这个频率自动刷新
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

/**
 * 生成一个全天事件
 * @param {string} dateStr  "YYYY-MM-DD"
 * @param {string} summary  标题
 * @param {object} opts     {desc, uid, transp}
 */
function allDayEvent(dateStr, summary, opts = {}) {
  const start = parseYmd(dateStr);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  const uid = opts.uid || `${fmtDate(start)}-${Buffer.from(summary).toString('hex').slice(0, 12)}@cn-holiday-ics`;
  // DTSTAMP 用事件日期本身，保证同一份数据多次生成结果完全一致，
  // 避免 CI 每天因时间戳变化产生无意义的提交
  const stamp = `${fmtDate(start)}T000000Z`;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${fmtDate(start)}`,
    `DTEND;VALUE=DATE:${fmtDate(end)}`,
    `SUMMARY:${escapeText(summary)}`,
  ];
  if (opts.desc) lines.push(`DESCRIPTION:${escapeText(opts.desc)}`);
  // TRANSP:TRANSPARENT 表示不占用忙碌时间，不干扰会议安排
  lines.push(`TRANSP:${opts.transp || 'TRANSPARENT'}`);
  lines.push('SEQUENCE:0');
  lines.push('STATUS:CONFIRMED');
  lines.push('END:VEVENT');
  return lines;
}

// ---------- 数据获取 ----------
const START_YEAR = 2022;
// 往后多取几年，官方未公布时接口会返回 success:false，自动跳过
const END_YEAR = new Date().getFullYear() + 3;

/** 从云日历 App 的本地缓存读取历史年份（接口已不再提供早年数据） */
function loadLocalHolidays() {
  const result = {};
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(APP_STORE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (!k.startsWith('localHoliday-') || !v || typeof v !== 'object') continue;
      const year = Number(k.split('-')[1]);
      if (!year) continue;
      const rest = [];
      const work = [];
      for (const [dayKey, flag] of Object.entries(v)) {
        if (flag === 2) rest.push(dayKey);
        else if (flag === 1) work.push(dayKey);
      }
      if (rest.length || work.length) {
        result[year] = { year, rest: rest.sort(), work: work.sort() };
      }
    }
    console.log(`  （已从云日历缓存读取 ${Object.keys(result).length} 个历史年份）`);
  } catch (_) {
    // 没有 App 缓存（如 CI 环境），改用仓库里固化的兜底数据
    try {
      const fb = JSON.parse(
        fs.readFileSync(path.join(DATA_DIR, 'fallback-holidays.json'), 'utf8')
      );
      for (const [y, c] of Object.entries(fb)) result[Number(y)] = c;
      console.log(`  （使用仓库内兜底数据 ${Object.keys(result).length} 个年份）`);
    } catch (_) {
      console.log('  （无历史数据，仅有接口年份）');
    }
  }
  return result;
}

async function loadLegalHolidays() {
  const result = {}; // year -> { rest:[dMMDD], work:[dMMDD], holidaystart:{} }

  // 1) 先铺本地缓存（含 2022-2024 等接口已下线的年份）
  const local = loadLocalHolidays();
  for (const [y, c] of Object.entries(local)) result[y] = c;

  // 2) 再用官方接口覆盖/补充（接口数据更新，且带节日名）
  const years = [];
  for (let y = START_YEAR; y <= END_YEAR; y++) years.push(y);

  const settled = await Promise.all(
    years.map(async (y) => {
      try {
        const d = await fetchJson(`${BASE}/getholiday?year=${y}`);
        if (d.success && d.content) return [y, d.content];
      } catch (_) { /* 该年份官方还没公布，忽略 */ }
      return [y, null];
    })
  );
  for (const [y, c] of settled) if (c) result[y] = c;
  return result;
}

async function loadFestivals() {
  const d = await fetchJson(`${BASE}/getfestivalinfo`);
  if (!d.success) throw new Error('节日接口返回失败: ' + d.message);
  return d.content; // { gregorian, lunar, gregorianmonthweek, byname }
}

// ---------- 年份内日期解析 ----------
/**
 * 在没有 holidaystart 字段时（历史缓存年份），推断某年主要法定节日的开始日
 * 返回 [{ ymd: MMDD, name }]
 */
function majorHolidayStarts(year) {
  const list = [];
  const add = (m, d, name) => list.push({ ymd: m * 100 + d, name });
  add(1, 1, '元旦');

  // 农历节日换算
  const pair = (lm, ld, name) => {
    const s = lunar.lunarToSolar(year, lm, ld);
    if (s && !s.error) list.push({ ymd: s.month * 100 + s.day, name });
  };
  pair(1, 1, '春节');
  pair(5, 5, '端午');
  pair(8, 15, '中秋');

  // 清明节：节气表索引 4（立春=0, 雨水=1, 惊蛰=2, 春分=3, 清明=4）
  // getTerm 返回的是"日"，月份需要按索引推算：2 月起每两个节气一个月
  try {
    const day = lunar.getTerm(year, 4);
    if (typeof day === 'number' && day > 0) {
      const month = 2 + Math.floor(4 / 2); // = 4 月
      add(month, day, '清明节');
    }
  } catch (_) { /* 拿不到就跳过 */ }

  add(5, 1, '劳动节');
  add(10, 1, '国庆节');
  return list.sort((a, b) => a.ymd - b.ymd);
}

/**
 * 公历固定日期节日：dMMDD
 */
function gregorianFestivalsForYear(gregorian, year) {
  const out = [];
  for (const key of Object.keys(gregorian)) {
    const mmdd = keyToYmd(key);
    const m = Math.floor(mmdd / 100);
    const dd = mmdd % 100;
    if (m < 1 || m > 12 || dd < 1 || dd > 31) continue;
    out.push({
      date: `${year}-${pad(m)}-${pad(dd)}`,
      items: gregorian[key],
    });
  }
  return out;
}

/**
 * 农历"月名"转 lunarToSolar 需要的"月份序号"
 * 该模块的 month 参数是含闰月的序号：若某年闰 L 月，
 * 则实际月名 m <= L 时序号仍为 m，m > L 时序号需 +1
 */
function lunarMonthToIndex(year, month) {
  const leap = lunar.getLunarLeapYear(year);
  if (leap > 0 && month > leap) return month + 1;
  return month;
}

/**
 * 农历节日：dMMDD 表示农历月日，需要用农历换算成公历年月日
 * 特殊：d0100 表示"除夕"，即农历当年腊月最后一天
 */
function lunarFestivalsForYear(lunarTable, year) {
  const out = [];
  for (const key of Object.keys(lunarTable)) {
    const mmdd = keyToYmd(key);
    const lm = Math.floor(mmdd / 100);
    const ld = mmdd % 100;

    if (ld === 0) {
      // 除夕 = 次年正月初一的前一天
      const cj = lunar.lunarToSolar(year + 1, 1, 1);
      if (cj && !cj.error) {
        const dt = new Date(cj.year, cj.month - 1, cj.day);
        dt.setDate(dt.getDate() - 1);
        out.push({
          date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
          items: lunarTable[key],
        });
      }
      continue;
    }

    const s = lunar.lunarToSolar(year, lunarMonthToIndex(year, lm), ld);
    if (s && !s.error) {
      out.push({
        date: `${s.year}-${pad(s.month)}-${pad(s.day)}`,
        items: lunarTable[key],
      });
    }
  }
  return out;
}

/**
 * "某月第 N 个星期 X" 型节日
 * 编码：d + MM + 第几个 + 星期几（0=周日 ... 6=周六）
 * 例：d0520 = 5 月第 2 个周日（母亲节）
 *     d0630 = 6 月第 3 个周日（父亲节）
 *     d1144 = 11 月第 4 个周四（感恩节）
 */
function monthWeekFestivalsForYear(table, year) {
  const out = [];
  for (const key of Object.keys(table)) {
    const digits = key.slice(1); // "0520" / "1144" 均为 4 位
    if (digits.length !== 4) continue;
    const m = Number(digits.slice(0, 2));   // 月
    const nth = Number(digits.slice(2, 3)); // 第几个
    const wd = Number(digits.slice(3, 4));  // 星期几
    if (m < 1 || m > 12 || nth < 1 || nth > 5 || wd < 0 || wd > 6) continue;

    const first = new Date(year, m - 1, 1);
    const diff = (wd - first.getDay() + 7) % 7;
    const day = 1 + diff + (nth - 1) * 7;
    // 校验不越月
    const dt = new Date(year, m - 1, day);
    if (dt.getMonth() !== m - 1) continue;
    out.push({
      date: `${year}-${pad(m)}-${pad(dt.getDate())}`,
      items: table[key],
      note: `第${nth}个${'日一二三四五六'[wd]}`,
    });
  }
  return out;
}

/** 二十四节气名（索引 0 为立春） */
const SOLAR_TERMS = [
  '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑',
  '立秋', '处暑', '白露', '秋分', '寒露', '霜降',
  '立冬', '小雪', '大雪', '冬至', '小寒', '大寒',
];

/**
 * 计算某年的二十四节气日期
 * 该模块 getTerm(year, i) 返回"日"，索引 0=立春（2 月）起每两个节气一个月，
 * 索引 22/23（小寒/大寒）已属于该年 12 月之后的次年 1 月，由 Date 自然进位。
 */
function solarTermsForYear(year) {
  const out = [];
  for (let i = 0; i < SOLAR_TERMS.length; i++) {
    let day;
    try {
      day = lunar.getTerm(year, i);
    } catch (_) {
      continue;
    }
    if (typeof day !== 'number' || day <= 0) continue;
    // i=0..21 -> 2 月..12 月；i=22,23 -> 次年 1 月
    const month = i >= 22 ? 13 : 2 + Math.floor(i / 2);
    const dt = new Date(year, month - 1, day); // month=13 时自动进位到次年 1 月
    out.push({
      date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
      name: SOLAR_TERMS[i],
    });
  }
  return out;
}

// ---------- 主流程 ----------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log('→ 拉取法定节假日…');
  const legal = await loadLegalHolidays();
  const legalYears = Object.keys(legal).map(Number).sort();
  console.log(`  已获取年份：${legalYears.join(', ')}`);

  console.log('→ 拉取节日库…');
  const fest = await loadFestivals();

  // 原始数据留档，方便复查
  fs.writeFileSync(
    path.join(DATA_DIR, 'raw-legalholiday.json'),
    JSON.stringify(legal, null, 2)
  );
  fs.writeFileSync(
    path.join(DATA_DIR, 'raw-festival.json'),
    JSON.stringify(fest, null, 2)
  );

  const nowStamp = fmtDT(new Date());
  const calYearNote = `${legalYears[0]}-${legalYears[legalYears.length - 1]}`;

  // ---------- 日历 1：法定节假日 + 调休 ----------
  const legalEvents = [];

  // 先把所有年份的休息日/补班日展开成绝对日期，跨年假期（如 12/31~1/2）才能连成一段。
  // 若逐年度处理，元旦假期会被年份边界切成两截。
  const restAbs = [];   // [{ y, md, date }]
  const workAbs = [];
  const allStarts = []; // [{ date, name, y }] 各节假日起始日

  for (const y of legalYears) {
    const c = legal[y];
    const asDate = (ymd) => new Date(y, Math.floor(ymd / 100) - 1, ymd % 100);

    for (const k of c.rest || []) {
      const ymd = keyToYmd(k);
      restAbs.push({ y, md: ymd, date: asDate(ymd) });
    }
    for (const k of c.work || []) {
      const ymd = keyToYmd(k);
      workAbs.push({ y, md: ymd, date: asDate(ymd) });
    }

    // 节假日起始日：接口给了 holidaystart；历史缓存年份按时序推断
    if (c.holidaystart) {
      for (const [name, key] of Object.entries(c.holidaystart)) {
        allStarts.push({ name, date: asDate(keyToYmd(key)), y });
      }
    } else {
      for (const s of majorHolidayStarts(y)) {
        allStarts.push({ name: s.name, date: asDate(s.ymd), y });
      }
    }
  }

  restAbs.sort((a, b) => a.date - b.date);
  workAbs.sort((a, b) => a.date - b.date);

  // 按绝对日期分组连续区间（跨年也连）
  const ranges = [];
  for (const item of restAbs) {
    const last = ranges[ranges.length - 1];
    if (last) {
      const expect = new Date(last.end);
      expect.setDate(expect.getDate() + 1);
      if (expect.getTime() === item.date.getTime()) {
        last.end = item.date;
        last.items.push(item);
        continue;
      }
    }
    ranges.push({ start: item.date, end: item.date, items: [item] });
  }

  for (const range of ranges) {
    // 假期名：取与区间首日最近（前后 7 天内）的节假日起始日
    let festName = '假期';
    let best = Infinity;
    for (const s of allStarts) {
      const diff = Math.abs(range.start.getTime() - s.date.getTime());
      if (diff <= 7 * 864e5 && diff < best) {
        best = diff;
        festName = s.name;
      }
    }
    const totalDays = range.items.length;
    for (let i = 0; i < range.items.length; i++) {
      const item = range.items[i];
      const dateStr = fmtISODate(item.date);
      // 关键：整段假期用完全相同的标题。
      // 苹果日历（以及多数客户端）只有在相邻全天事件标题一致时才画成连续横条，
      // 首日写「元旦（3天）」、其余写「放假」会被切成互不相连的方块。
      // 天数信息改放 DESCRIPTION，不影响显示连续性。
      legalEvents.push(
        allDayEvent(dateStr, `🎉 ${festName}`, {
          uid: `legal-rest-${dateStr}@cn-holiday-ics`,
          desc: `法定节假日：${festName}（第 ${i + 1}/${totalDays} 天，连休 ${totalDays} 天）\n数据来源：云日历 mtapi.ruanmei.com`,
        })
      );
    }
  }

  for (const item of workAbs) {
    const dateStr = fmtISODate(item.date);
    legalEvents.push(
      allDayEvent(dateStr, '⚠️ 调休上班（补班）', {
        uid: `legal-work-${dateStr}@cn-holiday-ics`,
        desc: '调休补班日\n数据来源：云日历 mtapi.ruanmei.com',
        // 补班是"要上班"，用 OPAQUE 让日历显示为忙碌更直观
        transp: 'OPAQUE',
      })
    );
  }

  const legalIcs = [
    ...icsHeader(
      '中国法定节假日',
      `法定节假日放假 / 调休补班（覆盖 ${calYearNote}）\n数据来源：云日历公开接口`,
      'Asia/Shanghai'
    ),
  ];
  for (const ev of legalEvents) legalIcs.push(...ev);
  legalIcs.push('END:VCALENDAR');
  const legalPath = path.join(OUT_DIR, 'china-holidays.ics');
  fs.writeFileSync(legalPath, legalIcs.map(foldLine).join('\r\n') + '\r\n');
  console.log(`  ✓ ${legalPath}  （${legalEvents.length} 个事件）`);

  // ---------- 日历 2：节日（公历 + 农历 + 某月第几个周几） ----------
  const festEvents = [];
  const seen = new Set();
  const pushFest = (dateStr, item, groupLabel) => {
    const uidKey = `${dateStr}-${item.name}`;
    if (seen.has(uidKey)) return;
    seen.add(uidKey);
    const star = item.isimportant ? '★ ' : '';
    festEvents.push(
      allDayEvent(dateStr, `${star}${item.name}`, {
        uid: `fest-${encodeURIComponent(uidKey)}@cn-holiday-ics`,
        desc: `${groupLabel}\n${item.isimportant ? '重点节日\n' : ''}简称：${item.shortname || item.name}`,
      })
    );
  };

  for (const y of legalYears) {
    for (const e of gregorianFestivalsForYear(fest.gregorian || {}, y)) {
      for (const it of e.items) pushFest(e.date, it, '公历节日');
    }
    for (const e of lunarFestivalsForYear(fest.lunar || {}, y)) {
      for (const it of e.items) pushFest(e.date, it, '农历节日');
    }
    for (const e of monthWeekFestivalsForYear(fest.gregorianmonthweek || {}, y)) {
      for (const it of e.items) pushFest(e.date, it, `公历节日（${e.note}）`);
    }
    for (const t of solarTermsForYear(y)) {
      pushFest(t.date, { name: t.name, shortname: t.name, isimportant: false }, '二十四节气');
    }
  }

  const festIcs = [
    ...icsHeader(
      '中国节日（公历 + 农历）',
      `公历节日、农历节日、节气类节日（覆盖 ${calYearNote}）\n数据来源：云日历公开接口`,
      'Asia/Shanghai'
    ),
  ];
  for (const ev of festEvents) festIcs.push(...ev);
  festIcs.push('END:VCALENDAR');
  const festPath = path.join(OUT_DIR, 'china-festivals.ics');
  fs.writeFileSync(festPath, festIcs.map(foldLine).join('\r\n') + '\r\n');
  console.log(`  ✓ ${festPath}  （${festEvents.length} 个事件）`);

  // ---------- 日历 3：合并版 ----------
  const allIcs = [
    ...icsHeader(
      '中国节假日完整版',
      `法定节假日 + 调休 + 全部节日（覆盖 ${calYearNote}）\n数据来源：云日历公开接口`,
      'Asia/Shanghai'
    ),
  ];
  for (const ev of legalEvents) allIcs.push(...ev);
  for (const ev of festEvents) allIcs.push(...ev);
  allIcs.push('END:VCALENDAR');
  const allPath = path.join(OUT_DIR, 'china-all.ics');
  fs.writeFileSync(allPath, allIcs.map(foldLine).join('\r\n') + '\r\n');
  console.log(`  ✓ ${allPath}  （${legalEvents.length + festEvents.length} 个事件）`);

  console.log('\n完成。');
}

main().catch((e) => {
  console.error('生成失败：', e);
  process.exit(1);
});

// ---------- 可选：内置 HTTP 服务，供 iPhone / Mac 用 URL 订阅 ----------
// 用法：node gen.js --serve [端口]
// 订阅地址示例：http://<你的局域网IP>:8787/china-holidays.ics
const serveFlag = process.argv.indexOf('--serve');
if (serveFlag !== -1) {
  const http = require('http');
  const os = require('os');
  const port = Number(process.argv[serveFlag + 1]) || 8787;

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const file = path.join(OUT_DIR, path.basename(url));
    // 防止路径穿越
    if (!file.startsWith(OUT_DIR) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 未找到。可用：/china-holidays.ics /china-festivals.ics /china-all.ics\n');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${path.basename(file)}"`,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(port, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
    console.log(`\n本地订阅服务已启动（端口 ${port}）`);
    console.log('可用地址：');
    for (const ip of ips) {
      console.log(`  http://${ip}:${port}/china-holidays.ics   ← 法定节假日`);
      console.log(`  http://${ip}:${port}/china-all.ics        ← 完整版`);
    }
    console.log('\niPhone 上：设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅的日历');
    console.log('按 Ctrl+C 停止。\n');
  });
}
