// 気象庁「潮位表」のデータを取ってきて data/tide/ に保存する（GitHub Actions で実行）。
//   data/tide/stations.json     … 潮位表の掲載地点（記号・名前・緯度経度）
//   data/tide/<年>/<記号>.txt   … 地点ごと1年分の潮位表（テキスト版そのまま）
// 過去の年のファイルは変わらないので、無いときだけ取る。今年と来年は毎回取り直す。
// 出典：気象庁ホームページ（潮位表）https://www.data.jma.go.jp/kaiyou/db/tide/suisan/

import fs from 'node:fs';
import path from 'node:path';

const OUT = 'data/tide';
const STATION_URL = 'https://www.data.jma.go.jp/kaiyou/db/tide/suisan/station.php';
const TXT_URL = (year, code) => `https://www.data.jma.go.jp/kaiyou/data/db/tide/suisan/txt/${year}/${code}.txt`;
const MIN_STATIONS = 50; // これより少なければ、ページの形が変わったとみなして止める

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'tsuri-reco (https://github.com/hirokode/tsuri-reco)' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || '';
      const head = buf.subarray(0, 2000).toString('latin1');
      const sjis = /shift_jis|sjis|x-sjis/i.test(type) || /charset=["']?(shift_jis|sjis|x-sjis)/i.test(head);
      return new TextDecoder(sjis ? 'shift_jis' : 'utf-8').decode(buf);
    } catch (e) {
      console.warn(`  ${url}: ${e.message}（${i + 1}回目）`);
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error(`取得できませんでした: ${url}`);
}

const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// 「35゜39'」（気象庁の表の書き方）・「35°39′」・「35度39分」などを度に直す
function degree(s) {
  const m = String(s).match(/(\d{2,3})\s*(?:゜|°|度|º|˚)\s*(\d{1,2}(?:\.\d+)?)/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}

// 一覧表の各行から「記号・名前・緯度・経度」を取り出す
function parseStations(html) {
  const rows = html.split(/<tr[\s>]/i).slice(1);
  const list = [];
  for (const row of rows) {
    const cells = row.split(/<t[dh][\s>]/i).slice(1).map(c => text(c.split(/<\/t[dh]>/i)[0]));
    const ci = cells.findIndex(c => /^[A-Z][A-Z0-9]$/.test(c));
    if (ci < 0 || !cells[ci + 1]) continue;
    const coords = cells.map(degree).filter(v => v !== null);
    const lat = coords.find(v => v >= 20 && v <= 46);
    const lng = coords.find(v => v >= 122 && v <= 154);
    if (lat === undefined || lng === undefined) continue;
    list.push({ code: cells[ci], name: cells[ci + 1], lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)) });
  }
  const seen = new Set();
  return list.filter(s => (seen.has(s.code) ? false : seen.add(s.code)));
}

// テキスト版の形になっているか（1行136桁以上・記号が一致・365日前後）
function validTxt(body, code) {
  const lines = body.split(/\r?\n/).filter(l => l.trim());
  return lines.length >= 360 && lines.every(l => l.length >= 136 && l.slice(78, 80) === code);
}

async function main() {
  const html = await get(STATION_URL);
  const stations = parseStations(html);
  console.log(`掲載地点：${stations.length}か所`);
  if (stations.length < MIN_STATIONS) {
    const at = html.search(/<table/i);
    console.log(`表の位置：${at}、行数：${html.split(/<tr[\s>]/i).length - 1}`);
    console.log(html.slice(Math.max(0, at), at + 6000));
    throw new Error('掲載地点を読み取れませんでした（ページの形が変わった可能性があります）');
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'stations.json'), JSON.stringify({ source: '気象庁 潮位表', url: STATION_URL, stations }, null, 0) + '\n');

  const now = new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear();
  const years = [now - 1, now, now + 1];
  let saved = 0, missing = 0, bad = 0;
  for (const year of years) {
    fs.mkdirSync(path.join(OUT, String(year)), { recursive: true });
    for (const s of stations) {
      const file = path.join(OUT, String(year), `${s.code}.txt`);
      if (year < now && fs.existsSync(file)) continue;
      const body = await get(TXT_URL(year, s.code));
      await sleep(150);
      if (body === null) { missing++; continue; }
      if (!validTxt(body, s.code)) { bad++; console.warn(`  形が違うので保存しません: ${year}/${s.code}`); continue; }
      fs.writeFileSync(file, body.replace(/\r\n/g, '\n'));
      saved++;
    }
    console.log(`${year}年：保存 ${saved}件（未公開 ${missing}件・形が違う ${bad}件）`);
    saved = missing = bad = 0;
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
