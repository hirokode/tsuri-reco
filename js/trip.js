// 釣行：開始〜終了のあいだの位置の記録と「釣れた！」の下書きを端末にため、終了時にまとめて GAS へ送る。
// PWA はバックグラウンドで位置を取れないので、定期取得はしない。記録するのは次のときだけ：
//   開始・アプリを開いたとき（5分に1回まで）・「釣れた！」・釣果登録・終了
// 記録するのは自分の位置のみ・釣行中のみ。

import { getCurrentPosition } from './map.js';

const OPEN_INTERVAL = 5 * 60 * 1000;      // アプリを開いたときの記録は5分に1回まで
export const TRIP_MAX_MS = 12 * 3600000;  // 開始から12時間で自動終了
export const TRIP_ASK_MS = 3 * 3600000;   // 最後の記録から3時間以上たって開いたら、続けるか確認

const activeKey = albumId => 'tr.trip.' + albumId;
const OUTBOX_KEY = 'tr.tripOutbox';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // 保存できなくても動作は続ける
  }
}

export function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------- 進行中の釣行（アルバムごとに1つ） ----------
// { trip_id, album_id, member_id, started_at, points: [{t, lat, lng, acc, kind}], drafts: [{draft_id, caught_at, lat, lng}] }

export function activeTrip(albumId) {
  return load(activeKey(albumId), null);
}

function saveActive(trip) {
  store(activeKey(trip.album_id), trip);
}

export function lastPointTime(trip) {
  const last = trip.points[trip.points.length - 1];
  return last ? Date.parse(last.t) : Date.parse(trip.started_at);
}

// 現在地を取って記録する。取れなければ null（釣行はそのまま続く）
// 釣行の記録は、その場の位置が要るので控えはほぼ使わない（開いたときの記録だけは1分以内の控えでよい）
export async function recordPoint(albumId, kind) {
  let pos;
  try {
    pos = await getCurrentPosition({ maxAge: kind === 'open' ? 60000 : 3000 });
  } catch (e) {
    return null;
  }
  const trip = activeTrip(albumId); // 位置を待つあいだに終了されていないか確かめる
  if (!trip) return null;
  const point = { t: new Date().toISOString(), lat: round(pos.lat), lng: round(pos.lng), acc: Math.round(pos.accuracy || 0), kind };
  trip.points.push(point);
  saveActive(trip);
  return point;
}

const round = v => Number(Number(v).toFixed(6));

export async function startTrip(albumId, memberId) {
  const trip = { trip_id: uuid(), album_id: albumId, member_id: memberId, started_at: new Date().toISOString(), points: [], drafts: [] };
  saveActive(trip);
  const point = await recordPoint(albumId, 'start');
  return { trip: activeTrip(albumId), point };
}

// アプリを開いたとき（5分に1回まで）
export function recordOpen(albumId) {
  const trip = activeTrip(albumId);
  if (!trip || Date.now() - lastPointTime(trip) < OPEN_INTERVAL) return Promise.resolve(null);
  return recordPoint(albumId, 'open');
}

// 「釣れた！」：時刻と現在地だけの下書きを作る。現在地が取れなければ、最後に記録した地点を使う
export async function addHitDraft(albumId) {
  const point = await recordPoint(albumId, 'hit');
  const trip = activeTrip(albumId);
  if (!trip) return null;
  const at = point || trip.points[trip.points.length - 1];
  if (!at) return { draft: null, fallback: false };
  const draft = { draft_id: uuid(), caught_at: point ? point.t : new Date().toISOString(), lat: at.lat, lng: at.lng };
  trip.drafts.push(draft);
  saveActive(trip);
  return { draft, fallback: !point };
}

export function removeDraft(albumId, draftId) {
  const trip = activeTrip(albumId);
  if (trip) {
    trip.drafts = trip.drafts.filter(d => d.draft_id !== draftId);
    saveActive(trip);
  }
  store(OUTBOX_KEY, outbox().map(o => ({ ...o, drafts: o.drafts.filter(d => d.draft_id !== draftId) })));
}

// 終了。auto：終了し忘れ（位置は取らず、最後に記録した時刻で終える）
export async function endTrip(albumId, { auto = false } = {}) {
  if (!auto) await recordPoint(albumId, 'end');
  const trip = activeTrip(albumId);
  if (!trip) return null;
  const ended = auto ? new Date(Math.min(lastPointTime(trip), Date.parse(trip.started_at) + TRIP_MAX_MS)) : new Date();
  const done = { ...trip, ended_at: ended.toISOString(), auto_ended: auto };
  store(OUTBOX_KEY, [...outbox().filter(o => o.trip_id !== done.trip_id), done]);
  store(activeKey(albumId), null);
  return done;
}

// ---------- 送信待ち（終了した釣行） ----------

export function outbox(albumId) {
  const list = load(OUTBOX_KEY, []);
  return albumId ? list.filter(o => o.album_id === albumId) : list;
}

// 送信待ちを送る。send(trip) は api('saveTrip', …) を呼ぶ関数。送れたものは消す
export async function flushOutbox(albumId, send) {
  let sent = 0;
  for (const trip of outbox(albumId)) {
    try {
      await send(trip);
      store(OUTBOX_KEY, outbox().filter(o => o.trip_id !== trip.trip_id));
      sent++;
    } catch (e) {
      return { sent, error: e };
    }
  }
  return { sent, error: null };
}

// ---------- 終了し忘れ ----------
// 'auto'：12時間を過ぎた（自動で終了する）／'ask'：最後の記録から3時間以上（続けるか確認）／null：そのまま
export function staleState(albumId) {
  const trip = activeTrip(albumId);
  if (!trip) return null;
  if (Date.now() - Date.parse(trip.started_at) > TRIP_MAX_MS) return 'auto';
  if (Date.now() - lastPointTime(trip) > TRIP_ASK_MS) return 'ask';
  return null;
}

// ---------- 位置の推定 ----------
// 時刻 t が入る自分の釣行（サーバーの釣行・送信待ち・進行中）から、t にいちばん近い記録地点を返す
export function estimatePoint(albumId, serverTrips, memberId, t) {
  const trips = [
    ...(serverTrips || []).filter(x => x.member_id === memberId),
    ...outbox(albumId),
    ...[activeTrip(albumId)].filter(Boolean)
  ];
  let best = null;
  for (const trip of trips) {
    const start = Date.parse(trip.started_at) - 60000; // 撮影時刻は秒まで。開始直前の写真も少し許す
    const end = trip.ended_at ? Date.parse(trip.ended_at) : Date.now() + 5 * 60000; // 進行中はカメラの時計のずれを少し許す
    if (t < start || t > end) continue;
    for (const p of trip.points || []) {
      const d = Math.abs(Date.parse(p.t) - t);
      if (!best || d < best.diff) best = { point: p, diff: d, trip_id: trip.trip_id };
    }
  }
  return best;
}
