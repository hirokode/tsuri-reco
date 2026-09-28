// 潮名（大潮・中潮・小潮・長潮・若潮）を、日付から計算する。外部サービスは使わない。
// 潮名は「月と太陽の黄経差（月の満ち欠けの角度）」で決まる呼び名で、場所には関係しない（全国共通）。
// 新月・満月の時刻を天文計算（Meeus『Astronomical Algorithms』49章）で求め、その間を按分して角度を出す。

const SYNODIC = 29.530588861; // 平均の朔望月（日）
const RAD = Math.PI / 180;

// 補正項の係数（新月・満月）と、角度の組み合わせ
const COEF = {
  new: [-0.40720, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208, -0.00111, -0.00057, 0.00056, -0.00042, 0.00042, 0.00038, -0.00024, -0.00017, -0.00007, 0.00004, 0.00004, 0.00003, 0.00003, -0.00003, 0.00003, -0.00002, -0.00002, 0.00002],
  full: [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209, -0.00111, -0.00057, 0.00056, -0.00042, 0.00042, 0.00038, -0.00024, -0.00017, -0.00007, 0.00004, 0.00004, 0.00003, 0.00003, -0.00003, 0.00003, -0.00002, -0.00002, 0.00002]
};

// k 番目（2000年1月の新月が0、満月は +0.5）の新月・満月のユリウス日
function phaseJd(k) {
  const T = k / 1236.85;
  const jde = 2451550.09766 + SYNODIC * k + 0.00015437 * T * T - 0.00000015 * T ** 3 + 0.00000000073 * T ** 4;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const M = (2.5534 + 29.1053567 * k - 0.0000014 * T * T - 0.00000011 * T ** 3) * RAD;
  const Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * T ** 3 - 0.000000058 * T ** 4) * RAD;
  const F = (160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * T ** 3 + 0.000000011 * T ** 4) * RAD;
  const Om = (124.7746 - 1.56375588 * k + 0.0020672 * T * T + 0.00000215 * T ** 3) * RAD;
  const terms = [
    Math.sin(Mp), E * Math.sin(M), Math.sin(2 * Mp), Math.sin(2 * F), E * Math.sin(Mp - M), E * Math.sin(Mp + M),
    E * E * Math.sin(2 * M), Math.sin(Mp - 2 * F), Math.sin(Mp + 2 * F), E * Math.sin(2 * Mp + M), Math.sin(3 * Mp),
    E * Math.sin(M + 2 * F), E * Math.sin(M - 2 * F), E * Math.sin(2 * Mp - M), Math.sin(Om), Math.sin(Mp + 2 * M),
    Math.sin(2 * Mp - 2 * F), Math.sin(3 * M), Math.sin(Mp + M - 2 * F), Math.sin(2 * Mp + 2 * F), Math.sin(Mp + M + 2 * F),
    Math.sin(Mp - M + 2 * F), Math.sin(Mp - M - 2 * F), Math.sin(3 * Mp + M), Math.sin(4 * Mp)
  ];
  const c = Number.isInteger(k) ? COEF.new : COEF.full;
  return jde + terms.reduce((sum, t, i) => sum + c[i] * t, 0);
}

const toJd = date => date.getTime() / 86400000 + 2440587.5;

// その時刻の月齢（直前の新月からの日数）と、黄経差（0〜360°）
export function moonPhase(date) {
  const jd = toJd(date);
  let k = Math.floor((jd - 2451550.09766) / SYNODIC);
  while (phaseJd(k) > jd) k--;
  while (phaseJd(k + 1) <= jd) k++;
  const newMoon = phaseJd(k);
  const fullMoon = phaseJd(k + 0.5);
  const nextNew = phaseJd(k + 1);
  const angle = jd < fullMoon
    ? 180 * (jd - newMoon) / (fullMoon - newMoon)
    : 180 + 180 * (jd - fullMoon) / (nextNew - fullMoon);
  return { age: jd - newMoon, angle };
}

// 黄経差から潮名（気象庁の区分：12°ごと、ほぼ1日ごと）
function tideFromAngle(a) {
  const x = a % 180; // 新月側と満月側は同じ並び
  if (x < 36 || x >= 168) return '大潮';
  if (x < 72) return '中潮';
  if (x < 108) return '小潮';
  if (x < 120) return '長潮';
  if (x < 132) return '若潮';
  return '中潮';
}

// その日（端末の日付）の正午の月から、潮名を決める
export function tideForDate(date) {
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
  const { age, angle } = moonPhase(noon);
  return { name: tideFromAngle(angle), age };
}

// ---------- 潮位（気象庁「潮位表」の予測値） ----------
// data/tide/stations.json（掲載地点）と data/tide/<年>/<記号>.txt（1年分）を読む。
// どちらも .github/workflows/update-tide.yml が気象庁から取り込んでいる。
// 潮位表の時刻は日本時間、潮位は各地点の潮位表基準面からの高さ（cm）。

const TIDE_DATA = 'data/tide/';
const JST = 9 * 3600000;
const HOUR = 3600000;
const DAY = 24 * HOUR;

let stationsPromise = null;
const yearCache = new Map(); // '記号/年' → Promise<Map<'YYYY-MM-DD', 1日分> | null>

function loadStations() {
  if (!stationsPromise) {
    stationsPromise = fetch(TIDE_DATA + 'stations.json')
      .then(r => (r.ok ? r.json() : null))
      .then(j => (j && Array.isArray(j.stations) ? j.stations : []))
      .catch(() => []);
    // 読めなかったときは、次に呼ばれたらもう一度試す
    stationsPromise.then(list => { if (!list.length) stationsPromise = null; });
  }
  return stationsPromise;
}

// 1行＝1日：毎時潮位（3桁×24）・年月日（2桁×3）・地点記号・満潮（時2桁＋分2桁＋潮位3桁）×4・干潮×4。
// 数字は右詰めで空白が入る（例：「 4 5」＝4時5分）。予測なしは 9999/999
function parseTideTxt(body, year) {
  const days = new Map();
  for (const line of body.split('\n')) {
    if (line.length < 136) continue;
    const num = (a, b) => Number(line.slice(a, b));
    const hourly = [];
    for (let h = 0; h < 24; h++) hourly.push(num(h * 3, h * 3 + 3));
    const events = [];
    [['満潮', 80], ['干潮', 108]].forEach(([type, start]) => {
      for (let i = 0; i < 4; i++) {
        const p = start + i * 7;
        if (line.slice(p, p + 4) === '9999') continue;
        const hh = num(p, p + 2);
        const mm = num(p + 2, p + 4);
        const h = num(p + 4, p + 7);
        if (![hh, mm, h].every(isFinite)) continue;
        events.push({ type, min: hh * 60 + mm, h });
      }
    });
    const key = `${year}-${String(num(74, 76)).padStart(2, '0')}-${String(num(76, 78)).padStart(2, '0')}`;
    if (hourly.every(isFinite)) days.set(key, { hourly, events });
  }
  return days;
}

function loadYear(code, year) {
  const k = `${code}/${year}`;
  if (!yearCache.has(k)) {
    const p = fetch(`${TIDE_DATA}${year}/${code}.txt`)
      .then(r => (r.ok ? r.text() : null))
      .then(t => (t ? parseTideTxt(t, year) : null))
      .catch(() => null);
    yearCache.set(k, p);
    p.then(v => { if (!v) yearCache.delete(k); }); // 通信できなかったときは次に取り直す
  }
  return yearCache.get(k);
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLng = (lng2 - lng1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

// 日本時間のその日（0時）の時刻（ms）と、日付の文字
function jstDay(ms) {
  const start = Math.floor((ms + JST) / DAY) * DAY - JST;
  const d = new Date(start + JST);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { start, key, year: d.getUTCFullYear() };
}

async function dayAt(code, ms) {
  const day = jstDay(ms);
  const year = await loadYear(code, day.year);
  const data = year && year.get(day.key);
  return data ? { ...day, ...data } : null;
}

// 日本時間の「時:分」
export function jstTime(ms) {
  const d = new Date(ms + JST);
  return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

async function nearestStation(lat, lng) {
  const stations = await loadStations();
  let best = null;
  for (const s of stations) {
    const km = distanceKm(lat, lng, s.lat, s.lng);
    if (!best || km < best.km) best = { station: s, km };
  }
  return best;
}

// from〜to を含む日（前後1日を足す）の、潮位の節点（毎時の値＋満潮・干潮の時刻と高さ）を時刻順に。
// 満干潮を節点に入れるので、山と谷の近くでも毎時の値だけより正確になる
async function knotsBetween(code, from, to) {
  const days = [];
  for (let ms = from - DAY; ms <= to + DAY; ms += DAY) days.push(dayAt(code, ms));
  const seen = new Set();
  const knots = [];
  const events = [];
  for (const d of await Promise.all(days)) {
    if (!d || seen.has(d.key)) continue;
    seen.add(d.key);
    d.hourly.forEach((h, i) => knots.push({ t: d.start + i * HOUR, h }));
    d.events.forEach(e => {
      const ev = { type: e.type, h: e.h, ms: d.start + e.min * 60000 };
      events.push(ev);
      knots.push({ t: ev.ms, h: e.h });
    });
  }
  knots.sort((a, b) => a.t - b.t);
  events.sort((a, b) => a.ms - b.ms);
  return { knots: knots.filter((k, i) => i === 0 || k.t !== knots[i - 1].t), events };
}

// 節点のあいだを直線でつないだ、時刻 t の潮位。範囲外なら null
function levelAt(knots, t) {
  if (!knots.length || t < knots[0].t || t > knots[knots.length - 1].t) return null;
  let lo = 0;
  let hi = knots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = knots[lo];
  const b = knots[hi];
  return b.t === a.t ? a.h : a.h + (b.h - a.h) * (t - a.t) / (b.t - a.t);
}

// その場所・時刻の潮位。いちばん近い掲載地点の予測値を使う。データが無ければ null
export async function tideLevel(lat, lng, date) {
  const t = date.getTime();
  if (!isFinite(lat) || !isFinite(lng) || !isFinite(t)) return null;
  const best = await nearestStation(lat, lng);
  if (!best) return null;
  const { knots, events } = await knotsBetween(best.station.code, t, t);
  const v = levelAt(knots, t);
  if (v == null) return { ...best, level: null };
  const day = jstDay(t);
  const dayEvents = events.filter(e => e.ms >= day.start && e.ms < day.start + DAY);
  const prev = [...events].reverse().find(e => e.ms <= t) || null;
  const next = events.find(e => e.ms > t) || null;
  const trend = next ? (next.type === '満潮' ? '上げ' : '下げ') : prev ? (prev.type === '満潮' ? '下げ' : '上げ') : '';
  return { ...best, level: Math.round(v), trend, prev, next, events: dayEvents };
}

// グラフ用：from〜to の潮位の線（節点）と、その間の満潮・干潮。データが無ければ null
export async function tideSeries(lat, lng, from, to) {
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const best = await nearestStation(lat, lng);
  if (!best) return null;
  const { knots, events } = await knotsBetween(best.station.code, from, to);
  const a = levelAt(knots, from);
  const b = levelAt(knots, to);
  if (a == null || b == null) return null;
  const inside = knots.filter(k => k.t > from && k.t < to);
  return {
    ...best,
    points: [{ t: from, h: a }, ...inside, { t: to, h: b }],
    events: events.filter(e => e.ms >= from && e.ms <= to),
    levelAt: t => levelAt(knots, t)
  };
}

// 潮の段階（連続値）：前の満干潮〜次の満干潮の時間を10に分けて何分目か（0〜10）。dir＝上げ／下げ。前後の満干潮が無ければ null
export function tideStageAt(events, t) {
  let prev = null;
  let next = null;
  for (const e of events) {
    if (e.ms <= t) prev = e;
    else { next = e; break; }
  }
  if (!prev || !next) return null;
  return { dir: prev.type === '干潮' ? '上げ' : '下げ', s: (t - prev.ms) / (next.ms - prev.ms) * 10, prev, next };
}

// 「上げ3分」のような表し方（四捨五入。0・10は「干潮」「満潮」）
export function stageLabel(st) {
  if (!st) return '';
  const n = Math.round(st.s);
  if (n <= 0) return st.prev.type;
  if (n >= 10) return st.next.type;
  return `${st.dir}${n}分`;
}

// 1か月分（日本時間の month 月）の潮位。{ station, km, from, to, events, levelAt }。データが無ければ null
export async function tideMonth(lat, lng, year, month) {
  if (!isFinite(lat) || !isFinite(lng)) return null;
  const best = await nearestStation(lat, lng);
  if (!best) return null;
  const from = Date.UTC(year, month - 1, 1) - JST;
  const to = Date.UTC(year, month, 1) - JST;
  const { knots, events } = await knotsBetween(best.station.code, from, to);
  if (!knots.some(k => k.t >= from && k.t < to)) return null;
  return { ...best, from, to, events, levelAt: t => levelAt(knots, t) };
}
