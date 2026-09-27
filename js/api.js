// GAS との通信と、端末（localStorage）への保存をまとめたもの。

const API_URL = (window.APP_CONFIG || {}).API_URL;

export class ApiError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || null;
  }
}

// GAS を呼ぶ。Content-Type を付けない（text/plain になり、CORS の事前確認が起きない）
export async function api(action, params = {}, { timeout = 30000 } = {}) {
  if (!API_URL) throw new ApiError('config', 'config.js に API_URL が設定されていません');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify({ action, ...params }),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new ApiError('network', navigator.onLine === false ? '電波がありません。つながる場所でもう一度試してください' : '通信に失敗しました。もう一度試してください');
  } finally {
    clearTimeout(timer);
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new ApiError('server', 'サーバーの応答が読めませんでした（GAS の承認やデプロイを確認してください）');
  }
  if (!json.ok) throw new ApiError(json.error, json.message, json.detail);
  return json.data;
}

// ---------- 端末への保存 ----------
// プライベートブラウズなどで使えないこともあるので、失敗しても止まらないようにする

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
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // 保存できなくても動作は続ける
  }
}

function drop(key) {
  try { localStorage.removeItem(key); } catch (e) { /* 何もしない */ }
}

// 参加中のアルバム（1端末で複数持てる）
// { token, album_id, album_name, member_id, display_name }
export function getSessions() {
  return load('tr.sessions', []);
}

export function sessionFor(albumId) {
  return getSessions().find(s => s.album_id === albumId) || null;
}

export function upsertSession(session) {
  const list = getSessions().filter(s => s.album_id !== session.album_id && s.token !== session.token);
  list.push(session);
  store('tr.sessions', list);
}

export function updateSession(albumId, patch) {
  const list = getSessions().map(s => (s.album_id === albumId ? { ...s, ...patch } : s));
  store('tr.sessions', list);
}

export function removeSession(token) {
  const removed = getSessions().find(s => s.token === token);
  store('tr.sessions', getSessions().filter(s => s.token !== token));
  if (removed && removed.album_id) drop('tr.album.' + removed.album_id);
}

// 設定（地図の初期レイヤー、最後に使った自分の名前）
export function getSettings() {
  return { layer: 'osm', myName: '', ...load('tr.settings', {}) };
}

export function saveSettings(patch) {
  store('tr.settings', { ...getSettings(), ...patch });
}

// アルバムのデータ（起動時にまず表示するための控え）
export function getAlbumCache(albumId) {
  return load('tr.album.' + albumId, null);
}

export function setAlbumCache(albumId, data) {
  store('tr.album.' + albumId, data);
}

// ホーム画面の一覧の控え
export function getHomeCache() {
  return load('tr.home', []);
}

export function setHomeCache(list) {
  store('tr.home', list);
}
