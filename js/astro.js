// 日の出・日の入り・月の出・月の入り（簡易計算。誤差は数分程度）
// 太陽と月の位置は低精度の式（天文年鑑の簡易式）で求め、地平線を横切る時刻を5分ごとの高度から探す。

const RAD = Math.PI / 180;
const STEP = 5 * 60000;

const sin = d => Math.sin(d * RAD);
const cos = d => Math.cos(d * RAD);

// 2000年1月1日12時（UT）からの日数
const daysJ2000 = ms => ms / 86400000 + 2440587.5 - 2451545.0;

// 黄道座標 → 赤経・赤緯（度）
function equatorial(lambda, beta, d) {
  const eps = 23.439 - 0.0000004 * d;
  const x = cos(beta) * cos(lambda);
  const y = cos(eps) * cos(beta) * sin(lambda) - sin(eps) * sin(beta);
  const z = sin(eps) * cos(beta) * sin(lambda) + cos(eps) * sin(beta);
  return { ra: Math.atan2(y, x) / RAD, dec: Math.asin(z) / RAD };
}

function sunPos(d) {
  const g = 357.529 + 0.98560028 * d;
  const q = 280.459 + 0.98564736 * d;
  return equatorial(q + 1.915 * sin(g) + 0.020 * sin(2 * g), 0, d);
}

function moonPos(d) {
  const L = 218.316 + 13.176396 * d;  // 平均黄経
  const M = 134.963 + 13.064993 * d;  // 平均近点角
  const F = 93.272 + 13.229350 * d;   // 緯度引数
  const D = 297.850 + 12.190749 * d;  // 平均離角
  const Ms = 357.529 + 0.98560028 * d; // 太陽の平均近点角
  const lambda = L + 6.289 * sin(M) - 1.274 * sin(M - 2 * D) + 0.658 * sin(2 * D)
    - 0.214 * sin(2 * M) - 0.186 * sin(Ms) - 0.114 * sin(2 * F);
  const beta = 5.128 * sin(F) + 0.281 * sin(M + F) + 0.278 * sin(M - F);
  return equatorial(lambda, beta, d);
}

function altitude(pos, ms, lat, lng) {
  const d = daysJ2000(ms);
  const { ra, dec } = pos(d);
  const lst = 280.46061837 + 360.98564736629 * d + lng;
  const h = lst - ra;
  return Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(h)) / RAD;
}

// from〜to の間に地平線（高度 h0）を横切る時刻。{ above（from の時点で出ているか）, rise: [ms], set: [ms] }
function crossings(pos, h0, from, to, lat, lng) {
  let prevT = from;
  let prevA = altitude(pos, from, lat, lng) - h0;
  const out = { above: prevA > 0, rise: [], set: [] };
  for (let t = from + STEP; t <= to; t += STEP) {
    const a = altitude(pos, t, lat, lng) - h0;
    if ((prevA <= 0) !== (a <= 0)) {
      const at = prevT + (t - prevT) * (prevA / (prevA - a));
      (a > 0 ? out.rise : out.set).push(Math.round(at));
    }
    prevT = t;
    prevA = a;
  }
  return out;
}

// 1日（from〜to）の太陽と月。出ている区間 spans: [{from, to}] と、出・入りの時刻
export function sunMoonDay(lat, lng, from, to) {
  const make = (pos, h0) => {
    const c = crossings(pos, h0, from, to, lat, lng);
    const marks = [...c.rise.map(t => ({ t, rise: true })), ...c.set.map(t => ({ t, rise: false }))].sort((a, b) => a.t - b.t);
    const spans = [];
    let start = c.above ? from : null;
    for (const m of marks) {
      if (m.rise) start = m.t;
      else if (start !== null) { spans.push({ from: start, to: m.t }); start = null; }
    }
    if (start !== null) spans.push({ from: start, to });
    return { spans, rise: c.rise, set: c.set };
  };
  // 太陽は大気差と視半径で -0.833°、月は視差なども入れて +0.125° を地平線とする
  return { sun: make(sunPos, -0.833), moon: make(moonPos, 0.125) };
}
