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

// その場所・時刻の潮位。いちばん近い掲載地点の予測値を使う。データが無ければ null
export async function tideLevel(lat, lng, date) {
  const t = date.getTime();
  if (!isFinite(lat) || !isFinite(lng) || !isFinite(t)) return null;
  const stations = await loadStations();
  if (!stations.length) return null;
  let best = null;
  for (const s of stations) {
    const km = distanceKm(lat, lng, s.lat, s.lng);
    if (!best || km < best.km) best = { station: s, km };
  }
  const [prevDay, today, nextDay] = await Promise.all([t - DAY, t, t + DAY].map(ms => dayAt(best.station.code, ms)));
  if (!today) return { ...best, level: null };

  // 毎時の値のあいだを直線でつなぐ（23時台は翌日0時の値を使う）
  const pos = (t - today.start) / HOUR;
  const h0 = Math.floor(pos);
  const a = today.hourly[h0];
  const b = h0 < 23 ? today.hourly[h0 + 1] : (nextDay ? nextDay.hourly[0] : a);
  const level = Math.round(a + (b - a) * (pos - h0));

  const toEvents = d => (d ? d.events.map(e => ({
    type: e.type, h: e.h, ms: d.start + e.min * 60000
  })) : []);
  const dayEvents = toEvents(today).sort((x, y) => x.ms - y.ms);
  const all = [...toEvents(prevDay), ...dayEvents, ...toEvents(nextDay)].sort((x, y) => x.ms - y.ms);
  const prev = [...all].reverse().find(e => e.ms <= t) || null;
  const next = all.find(e => e.ms > t) || null;
  const trend = next ? (next.type === '満潮' ? '上げ' : '下げ') : prev ? (prev.type === '満潮' ? '下げ' : '上げ') : '';
  return { ...best, level, trend, prev, next, events: dayEvents };
}
