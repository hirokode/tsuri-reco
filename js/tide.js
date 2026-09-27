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
