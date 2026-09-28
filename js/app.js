// Tsuri Reco の画面。URL の # 以降で画面を切り替える。
//   #/                     ホーム（アルバム一覧）
//   #/start                アルバムを作る／招待リンクを貼り付けて参加
//   #/join                 招待から参加
//   #/a/<id>/invite        招待リンクを送る（アルバム作成直後）
//   #/a/<id>/map | list    アルバム（地図／一覧）
//   #/a/<id>/new?lat=&lng=&place= 釣果の登録（?draft=<id> で「釣れた！」の下書きの続き）
//   #/a/<id>/trip          釣行（開始・終了・釣れた！）
//   #/a/<id>/tide?p=&m=    月間潮表（釣ったポイントの1か月の潮と、釣れたときに似ている日時）
//   #/a/<id>/c/<cid>       詳細
//   #/a/<id>/c/<cid>/edit  編集
//   #/a/<id>/settings      設定
//   #/a/<id>/edit          アルバム名・アイコン画像の編集

import {
  api, ApiError, getSessions, sessionFor, upsertSession, updateSession, removeSession,
  getSettings, saveSettings, getAlbumCache, setAlbumCache, getHomeCache, setHomeCache
} from './api.js';
import { MAX_PHOTOS, photoImg, preparePhoto, prepareIcon, blobToBase64 } from './photos.js';
import { tideForDate, tideLevel, tideSeries, tideMonth, tideStageAt, stageLabel, jstTime } from './tide.js';
import { sunMoonDay } from './astro.js';
import {
  activeTrip, startTrip, endTrip, recordPoint, recordOpen, addHitDraft, removeDraft, outbox, flushOutbox,
  staleState, estimatePoint, lastPointTime
} from './trip.js';
import { LAYERS, ROUTE_COLORS, mapReady, createCatchMap, createPickerMap, createMiniMap, getCurrentPosition } from './map.js';

const $app = document.getElementById('app');
const TIDES = ['大潮', '中潮', '小潮', '長潮', '若潮'];
const INVITE_KEY = 'tr.invite';

// ---------- 小さな道具 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

// <input type="datetime-local"> 用の値
function toLocalInput(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 端末のタイムゾーン付きの ISO 形式（例：2026-09-27T10:00:00+09:00）
function toLocalIso(date) {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${toLocalInput(date)}:${pad(date.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function fmtCoord(lat, lng) {
  return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
}

// 「35.1, 138.8」「35.1,138.8」や Google マップの URL（@35.1,138.8,15z）から緯度経度を取り出す
function parseLatLng(text) {
  const s = String(text || '')
    .replace(/[０-９．－]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，、]/g, ',');
  const m = s.match(/(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function googleMapsUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function appBaseUrl() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

// 招待リンク。LINE で開いたときに LINE 内ブラウザではなく普段のブラウザで開くようにする
function inviteUrl(token) {
  return `${appBaseUrl()}?invite=${token}&openExternalBrowser=1`;
}

function extractInviteToken(text) {
  const s = String(text || '').trim();
  const m = s.match(/invite=([a-f0-9]{64})/i) || s.match(/^([a-f0-9]{64})$/i);
  return m ? m[1].toLowerCase() : null;
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// スマホ・タブレットかどうか。「LINEで送る」（line.me/R/share）はスマホのLINEアプリでしか開けず、
// PCではLINE公式サイトが開いてしまうため、PCではコピーだけにする
function isMobileDevice() {
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean' && navigator.userAgentData.mobile) return true;
  return isIOS() || /Android|Mobile/i.test(navigator.userAgent);
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function toast(message, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), ms);
}

function busy(on, message = '保存中…') {
  let el = document.getElementById('busy');
  if (!el) {
    el = document.createElement('div');
    el.id = 'busy';
    el.innerHTML = '<div class="busy-box"><div class="spinner"></div><p></p></div>';
    document.body.appendChild(el);
  }
  el.querySelector('p').textContent = message;
  el.classList.toggle('show', on);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('コピーしました');
}

function lineShareUrl(text) {
  return 'https://line.me/R/share?text=' + encodeURIComponent(text);
}

function icon(name) {
  const paths = {
    back: '<path d="M15 5l-7 7 7 7" />',
    settings: '<path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20"/><circle cx="15" cy="7" r="2.5"/><circle cx="9" cy="17" r="2.5"/>',
    map: '<path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z M9 4v13.5 M15 6.5V20"/>',
    list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
    pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z M13 7l4 4"/>',
    trip: '<path d="M6.5 12c2.2-3.6 5.4-5.5 8.8-5.5 2.6 0 4.5 2 5.7 5.5-1.2 3.5-3.1 5.5-5.7 5.5-3.4 0-6.6-1.9-8.8-5.5z M6.5 12L2.5 8v8z"/><circle cx="16.6" cy="10.8" r=".6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
    moon: '<path d="M19.5 14.5A8 8 0 019.5 4.5a8 8 0 1010 10z"/>',
    tide: '<path d="M3 9.5c2.2 0 2.3-2 4.5-2s2.3 2 4.5 2 2.3-2 4.5-2 2.3 2 4.5 2 M3 15.5c2.2 0 2.3-2 4.5-2s2.3 2 4.5 2 2.3-2 4.5-2 2.3 2 4.5 2"/>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ''}</svg>`;
}

function topbar(title, { back = null, right = '' } = {}) {
  return `<header class="topbar">
    ${back ? `<button class="icon-btn" data-back="${esc(back)}" aria-label="戻る">${icon('back')}</button>` : '<span class="icon-spacer"></span>'}
    <h1>${esc(title)}</h1>
    ${right || '<span class="icon-spacer"></span>'}
  </header>`;
}

function errorBox(message, retry = true) {
  return `<div class="notice error"><p>${esc(message)}</p>${retry ? '<button class="btn small" data-action="reload">もう一度読み込む</button>' : ''}</div>`;
}

// 読み込みに失敗した写真は予備のURLに切り替える
document.addEventListener('error', e => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.dataset.fallback && !img.dataset.fellBack) {
    img.dataset.fellBack = '1';
    img.src = img.dataset.fallback;
  }
}, true);

// ---------- 画面の切り替え ----------

let current = { cleanup: null, refresh: null, albumId: null };

// アプリ内で見た画面の履歴（「戻る」でアプリの外に出ないようにするため）
const visited = [location.hash || '#/'];
let replacing = false;
let navDir = 'fade'; // 画面が切り替わるときの動き：fwd（進む）/ back（戻る）/ fade（置き換え）

function replaceHash(hash) {
  replacing = true;
  location.replace(hash);
}

// 前の画面へ。アプリ内の前の画面があれば履歴を戻り、なければ指定の画面へ
function goBack(fallback) {
  if (visited.length > 1) history.back();
  else replaceHash(fallback);
}

// アルバムの一覧へ。前の画面に戻るのではなく、まっすぐ一覧を開く（アプリ内の履歴もそこから始め直す）
let homing = false;
function goHome() {
  homing = true;
  location.hash = '#/';
}

window.addEventListener('hashchange', () => {
  const hash = location.hash || '#/';
  if (homing) {
    visited.length = 0;
    visited.push(hash);
    homing = false;
    navDir = 'back';
  } else if (replacing) {
    visited[visited.length - 1] = hash;
    replacing = false;
    navDir = 'fade';
  } else if (visited.length > 1 && visited[visited.length - 2] === hash) {
    visited.pop();
    navDir = 'back';
  } else {
    visited.push(hash);
    navDir = 'fwd';
  }
  render();
});

$app.addEventListener('click', e => {
  if (e.target.closest('[data-home]')) {
    e.preventDefault();
    goHome();
    return;
  }
  const back = e.target.closest('[data-back]');
  if (back) {
    e.preventDefault();
    goBack(back.dataset.back);
    return;
  }
  const reload = e.target.closest('[data-action="reload"]');
  if (reload) render();
});

function parseRoute() {
  const hash = location.hash || '#/';
  const [path, query = ''] = hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  return { parts, params };
}

// 新しい画面の本文を、切り替わる向きに合わせて滑らかに出す
function animateEnter() {
  if (replacing) return; // 別の画面へ置き換え中（その画面の表示のときに動かす）
  const main = $app.querySelector('main');
  if (main) main.classList.add('enter-' + navDir);
  navDir = 'fade';
}

// 指を離すまで（最大 ms ミリ秒）、画面の文字が選択されないようにする。
// 長押しで画面が切り替わったとき、押したままの指で新しい画面の文字が選択されてしまうのを防ぐ
function guardSelection(ms = 2500) {
  document.body.classList.add('no-select');
  const release = () => {
    clearTimeout(guardSelection.timer);
    guardSelection.timer = setTimeout(() => {
      document.body.classList.remove('no-select');
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.type === 'Range') sel.removeAllRanges();
    }, 300);
  };
  ['touchend', 'touchcancel', 'pointerup'].forEach(ev => document.addEventListener(ev, release, { once: true, capture: true }));
  clearTimeout(guardSelection.timer);
  guardSelection.timer = setTimeout(release, ms);
}

function render() {
  renderView();
  animateEnter();
}

function renderView() {
  if (current.cleanup) {
    try { current.cleanup(); } catch (e) { console.error(e); }
  }
  current = { cleanup: null, refresh: null, albumId: null };
  window.scrollTo(0, 0);

  const { parts, params } = parseRoute();
  if (parts.length === 0) return viewHome();
  if (parts[0] === 'start') return viewStart();
  if (parts[0] === 'join') return viewJoin();
  if (parts[0] === 'a' && parts[1]) {
    const albumId = parts[1];
    if (!sessionFor(albumId)) {
      replaceHash('#/');
      return;
    }
    current.albumId = albumId;
    const sub = parts[2];
    if (sub === 'invite') return viewInviteShare(albumId);
    if (sub === 'map' || sub === 'list') return viewAlbum(albumId, sub);
    if (sub === 'new') return viewForm(albumId, null, params);
    if (sub === 'settings') return viewSettings(albumId);
    if (sub === 'trip') return viewTrip(albumId);
    if (sub === 'tide') return viewTideMonth(albumId, params);
    if (sub === 'edit') return viewAlbumEdit(albumId);
    if (sub === 'c' && parts[3]) {
      if (parts[4] === 'edit') return viewForm(albumId, parts[3], params);
      return viewDetail(albumId, parts[3]);
    }
    replaceHash(`#/a/${albumId}/list`);
    return;
  }
  replaceHash('#/');
}

// ---------- アルバムのデータ（端末の控え → 裏で最新を取得） ----------

const albumState = {}; // albumId → { data, pending: [], loading, error, promise }

function stateOf(albumId) {
  if (!albumState[albumId]) {
    albumState[albumId] = { data: getAlbumCache(albumId), pending: [], loading: false, error: null, promise: null };
  }
  return albumState[albumId];
}

function notify(albumId) {
  if (current.albumId === albumId && current.refresh) current.refresh();
}

function refreshAlbum(albumId) {
  const st = stateOf(albumId);
  if (st.promise) return st.promise;
  const session = sessionFor(albumId);
  st.loading = true;
  st.promise = api('getAlbum', { token: session.token })
    .then(data => {
      st.data = data;
      st.error = null;
      setAlbumCache(albumId, data);
      updateSession(albumId, { album_name: data.album.name, display_name: data.me.display_name, member_id: data.me.member_id });
    })
    .catch(e => {
      st.error = e;
    })
    .finally(() => {
      st.loading = false;
      st.promise = null;
      notify(albumId);
    });
  return st.promise;
}

function saveStateCache(albumId) {
  const st = stateOf(albumId);
  if (st.data) setAlbumCache(albumId, st.data);
}

// 送信中のものも含めて、新しい順
function catchesOf(albumId) {
  const st = stateOf(albumId);
  const saved = st.data ? st.data.catches : [];
  const ids = new Set(saved.map(c => c.catch_id));
  const drafts = localDrafts(albumId).filter(d => !ids.has(d.catch_id));
  return [...st.pending, ...drafts, ...saved].sort((a, b) => (a.caught_at < b.caught_at ? 1 : a.caught_at > b.caught_at ? -1 : 0));
}

// 「釣れた！」の下書きのうち、まだ送っていないもの（進行中の釣行と送信待ち）を釣果の形にする
function localDrafts(albumId) {
  const session = sessionFor(albumId);
  const trips = [activeTrip(albumId), ...outbox(albumId)].filter(Boolean);
  return trips.flatMap(t => t.drafts.map(d => ({
    catch_id: d.draft_id, caught_at: d.caught_at, lat: d.lat, lng: d.lng, place_name: '', species: '', count: 1,
    angler_member_id: session ? session.member_id : '', photo_ids: [], draft: true, loc_source: 'button', trip_id: t.trip_id,
    _localDraft: true
  })));
}

// 釣行（サーバーのもの＋送信待ち）。新しい順
function tripsOf(albumId) {
  const st = stateOf(albumId);
  const saved = (st.data && st.data.trips) || [];
  const ids = new Set(saved.map(t => t.trip_id));
  return [...outbox(albumId).filter(t => !ids.has(t.trip_id)).map(t => ({ ...t, _unsent: true })), ...saved]
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
}

const LOC_SOURCE_LABEL = { button: '📍釣れた！', estimated: '推定', manual: '手動' };
function locSourceChip(c) {
  return c.loc_source ? `<span class="loc-src">位置：${esc(LOC_SOURCE_LABEL[c.loc_source] || '')}</span>` : '';
}

// 2点の距離（m）
function distanceM(a, b) {
  const R = Math.PI / 180;
  const x = (b.lng - a.lng) * R * Math.cos(((a.lat + b.lat) / 2) * R);
  const y = (b.lat - a.lat) * R;
  return Math.sqrt(x * x + y * y) * 6371000;
}

function memberName(albumId, memberId) {
  const st = stateOf(albumId);
  const m = st.data && st.data.members.find(x => x.member_id === memberId);
  return m ? (m.display_name || '（名前未設定）') : '';
}

function memberIndex(albumId, memberId) {
  const st = stateOf(albumId);
  const i = st.data ? st.data.members.findIndex(x => x.member_id === memberId) : -1;
  return i < 0 ? 0 : i;
}

function albumTitle(albumId) {
  const st = stateOf(albumId);
  return (st.data && st.data.album.name) || (sessionFor(albumId) || {}).album_name || 'アルバム';
}

function invalidTokenBox(albumId) {
  return `<div class="notice error"><p>このアルバムには入れなくなりました（招待リンクが無効になっています）。</p>
    <button class="btn small" data-remove-album="${esc(albumId)}">この端末から外す</button></div>`;
}

$app.addEventListener('click', e => {
  const btn = e.target.closest('[data-remove-album]');
  if (!btn) return;
  const s = sessionFor(btn.dataset.removeAlbum);
  if (s && confirm('このアルバムをこの端末から外しますか？（データは消えません）')) {
    removeSession(s.token);
    location.hash = '#/';
  }
});

// ---------- ホーム ----------

function viewHome() {
  const sessions = getSessions();
  if (!sessions.length) {
    replaceHash('#/start');
    return;
  }
  let summaries = getHomeCache();
  let error = null;

  function draw() {
    const cards = getSessions().map(s => {
      const sum = summaries.find(x => x.token === s.token);
      if (sum && sum.valid === false) {
        return `<div class="album-card invalid">
          <div class="album-thumb"></div>
          <div class="album-body"><h2>${esc(s.album_name || 'アルバム')}</h2><p class="muted">使えなくなったアルバムです</p>
          <button class="btn small" data-remove-album="${esc(s.album_id)}">この端末から外す</button></div></div>`;
      }
      const others = sum ? sum.members.filter(m => m.member_id !== s.member_id) : [];
      const joinedOthers = others.filter(m => m.joined).map(m => m.display_name);
      const waiting = others.filter(m => !m.joined).length;
      const people = joinedOthers.length ? joinedOthers.join('・') + 'と' : '';
      // アイコン画像があればそれを、なければ最新の釣果の写真を出す
      const cover = sum && (sum.album_icon || sum.last_photo);
      return `<div class="album-item">
        <a class="album-card" href="#/a/${esc(s.album_id)}/list">
        <div class="album-thumb">${cover ? photoImg(cover.t, 400) : icon('map')}</div>
        <div class="album-body">
          <h2>${esc(sum ? sum.album_name : s.album_name)}</h2>
          <p class="muted">${esc(people)}${waiting ? '<span class="chip">招待中</span>' : ''}</p>
          <p class="muted small">${sum ? `${sum.catch_count}件${sum.last_caught_at ? '・最終 ' + fmtDate(sum.last_caught_at) : ''}` : ''}</p>
        </div></a>
        <a class="album-edit" href="#/a/${esc(s.album_id)}/edit" aria-label="アルバム名・アイコンを編集">${icon('edit')}</a>
      </div>`;
    }).join('');
    $app.innerHTML = `${topbar('Tsuri Reco')}
      <main class="page">
        ${error ? `<div class="notice error"><p>${esc(error)}</p></div>` : ''}
        <div class="album-list">${cards}</div>
        <a class="btn primary block" href="#/start">＋ 新しいアルバム</a>
        <p class="center small"><a href="#/start?focus=paste">招待リンクを貼り付けて参加する</a></p>
      </main>`;
  }

  draw();
  const tokens = sessions.map(s => s.token);
  api('listAlbums', { tokens })
    .then(list => {
      summaries = list;
      setHomeCache(list);
      list.filter(x => x.valid).forEach(x => {
        const s = sessions.find(y => y.token === x.token);
        if (s) updateSession(s.album_id, { album_name: x.album_name, display_name: x.me.display_name });
      });
      error = null;
    })
    .catch(e => { error = e.message; })
    .finally(() => { if (location.hash === '' || location.hash === '#/' ) draw(); });
}

// ---------- アルバムを作る／招待リンクを貼り付け ----------

function viewStart() {
  const settings = getSettings();
  const hasSessions = getSessions().length > 0;
  const iosBrowser = isIOS() && !isStandalone();
  $app.innerHTML = `${topbar(hasSessions ? '新しいアルバム' : 'Tsuri Reco', { back: hasSessions ? '#/' : null })}
    <main class="page">
      ${hasSessions ? '' : '<p class="lead">友達と釣果を記録・共有するアプリです。<br>まずはアルバムを作って、友達を招待しましょう。</p>'}
      ${iosBrowser ? `<div class="notice info"><p><b>先にホーム画面に追加して、アイコンから開いて使うのがおすすめです。</b><br>
        iPhone では Safari とホーム画面のアプリでデータが別々になるためです（共有ボタン <span aria-hidden="true">⎋</span> →「ホーム画面に追加」）。</p></div>` : ''}
      <form id="create-form" class="card form">
        <h2>アルバムを作る</h2>
        <label>あなたの名前<input name="my_name" required maxlength="30" value="${esc(settings.myName)}" autocomplete="nickname"></label>
        <label>友達の名前<input name="friend_name" maxlength="30" placeholder="例：たろう"></label>
        <label>アルバム名<input name="album_name" maxlength="50" placeholder="例：たろうとの釣り"></label>
        <button class="btn primary block" type="submit">作成して招待リンクを発行</button>
      </form>
      <form id="paste-form" class="card form">
        <h2>招待リンクを貼り付けて参加</h2>
        <p class="muted small">友達から届いた招待リンクや、自分の招待リンク（機種変更・ホーム画面に追加したとき）を貼り付けてください。</p>
        <div class="row">
          <input name="link" placeholder="https://…?invite=…" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="btn" type="button" id="paste-btn">貼り付け</button>
        </div>
        <button class="btn block" type="submit">参加する</button>
      </form>
    </main>`;

  if (parseRoute().params.get('focus') === 'paste') {
    document.getElementById('paste-form').scrollIntoView();
  }

  const form = document.getElementById('create-form');
  const friend = form.elements.friend_name;
  const albumName = form.elements.album_name;
  let albumNameTouched = false;
  albumName.addEventListener('input', () => { albumNameTouched = true; });
  friend.addEventListener('input', () => {
    if (!albumNameTouched) albumName.value = friend.value.trim() ? `${friend.value.trim()}との釣り` : '';
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const my = form.elements.my_name.value.trim();
    if (!my) return toast('あなたの名前を入力してください');
    busy(true, 'アルバムを作っています…');
    try {
      const res = await api('createAlbum', {
        my_name: my,
        friend_name: friend.value.trim(),
        album_name: albumName.value.trim()
      });
      saveSettings({ myName: my });
      upsertSession({ token: res.me.token, album_id: res.album_id, album_name: res.album_name, member_id: res.me.member_id, display_name: my });
      setAlbumCache(res.album_id, {
        album: { album_id: res.album_id, name: res.album_name },
        me: { member_id: res.me.member_id, display_name: my, joined: true },
        members: [
          { member_id: res.me.member_id, display_name: my, joined: true },
          { member_id: res.invite.member_id, display_name: res.invite.display_name, joined: false }
        ],
        invites: [res.invite],
        catches: []
      });
      location.hash = `#/a/${res.album_id}/invite`;
    } catch (err) {
      toast(err.message, 4000);
    } finally {
      busy(false);
    }
  });

  const paste = document.getElementById('paste-form');
  document.getElementById('paste-btn').addEventListener('click', async () => {
    try {
      paste.elements.link.value = await navigator.clipboard.readText();
    } catch (e) {
      toast('入力欄を長押しして「ペースト」してください');
    }
  });
  paste.addEventListener('submit', e => {
    e.preventDefault();
    const token = extractInviteToken(paste.elements.link.value);
    if (!token) return toast('招待リンクの形が正しくありません');
    sessionStorage.setItem(INVITE_KEY, token);
    location.hash = '#/join';
  });
}

// ---------- 招待リンクを送る（作成直後） ----------

function shareBlock(token, who) {
  const url = inviteUrl(token);
  const message = `Tsuri Reco の釣果アルバムに招待します。\nこのリンクから参加してね（他の人には送らないでね）\n${url}`;
  return `<div class="share">
    <p class="muted small">${esc(who)}</p>
    <input class="link-box" readonly value="${esc(url)}" aria-label="招待リンク">
    <div class="row">
      <button class="btn" data-copy="${esc(url)}">コピー</button>
      ${isMobileDevice() ? `<a class="btn line" href="${esc(lineShareUrl(message))}" target="_blank" rel="noopener">LINEで送る</a>
      ${navigator.share ? `<button class="btn" data-share="${esc(url)}">共有</button>` : ''}` : ''}
    </div>
    ${isMobileDevice() ? '' : '<p class="muted small">コピーして、PC版LINEなどのトーク画面に貼り付けて送ってください。</p>'}
  </div>`;
}

$app.addEventListener('click', e => {
  const c = e.target.closest('[data-copy]');
  if (c) {
    e.preventDefault();
    copyText(c.dataset.copy);
    return;
  }
  const s = e.target.closest('[data-share]');
  if (s) {
    e.preventDefault();
    navigator.share({ title: 'Tsuri Reco の招待', text: 'Tsuri Reco の釣果アルバムに招待します', url: s.dataset.share }).catch(() => {});
  }
});

function viewInviteShare(albumId) {
  const st = stateOf(albumId);
  const invites = (st.data && st.data.invites) || [];
  $app.innerHTML = `${topbar('友達を招待', { back: '#/' })}
    <main class="page">
      <div class="card">
        <h2>「${esc(albumTitle(albumId))}」を作りました</h2>
        <p>下のリンクを友達に送ってください。リンクを開くと、このアルバムに参加できます。</p>
        ${invites.length ? invites.map(i => shareBlock(i.token, `${i.display_name || '友達'}さん用の招待リンク`)).join('') : '<p class="muted">招待リンクは設定画面からも表示できます。</p>'}
        <p class="muted small">招待リンクは合鍵のようなものです。送る相手以外には教えないでください。</p>
      </div>
      <a class="btn primary block" href="#/a/${esc(albumId)}/list">アルバムを開く</a>
    </main>`;
}

// ---------- 招待から参加 ----------

function viewJoin() {
  const token = sessionStorage.getItem(INVITE_KEY);
  if (!token) {
    replaceHash('#/');
    return;
  }
  $app.innerHTML = `${topbar('アルバムに参加', { back: '#/' })}<main class="page"><div class="skeleton-card"></div></main>`;

  api('getInvite', { token })
    .then(info => {
      const existing = getSessions().find(s => s.token === token);
      if (existing) {
        sessionStorage.removeItem(INVITE_KEY);
        replaceHash(`#/a/${info.album_id}/list`);
        return;
      }
      const inviters = info.members.filter(m => m.member_id !== info.you.member_id && m.joined).map(m => m.display_name);
      const needsHomeScreen = isIOS() && !isStandalone();
      const url = inviteUrl(token);
      $app.innerHTML = `${topbar('アルバムに参加', { back: '#/' })}
        <main class="page">
          <div class="card">
            <p class="muted small">${inviters.length ? esc(inviters.join('・')) + 'さんからの招待' : '招待'}</p>
            <h2>${esc(info.album_name)}</h2>
          </div>
          ${needsHomeScreen ? `<div class="notice info" id="homescreen-guide">
            <p><b>先にホーム画面に追加して、アイコンから開いてから参加してね</b></p>
            <ol>
              <li>下の「招待リンクをコピー」を押す</li>
              <li>画面下の共有ボタン（□に↑）→「ホーム画面に追加」</li>
              <li>ホーム画面の「Tsuri Reco」アイコンから開く</li>
              <li>「招待リンクを貼り付けて参加」にリンクを貼り付けて「参加する」</li>
            </ol>
            <p class="muted small">iPhone では Safari とホーム画面のアプリでデータが別々のため、この順番だとアイコンから開いたときにそのまま使えます。</p>
            <button class="btn primary block" data-copy="${esc(url)}">招待リンクをコピー</button>
            <button class="btn text block" id="join-here">ホーム画面に追加せず、このまま参加する</button>
          </div>` : ''}
          <form id="join-form" class="card form" ${needsHomeScreen ? 'hidden' : ''}>
            ${info.you.joined
              ? `<p>「${esc(info.you.display_name)}」として参加済みです。この端末でも使えるようにします。</p>
                 <button class="btn primary block" type="submit">このアルバムに入る</button>`
              : `<label>あなたの表示名<input name="display_name" required maxlength="30" value="${esc(info.you.display_name || getSettings().myName)}"></label>
                 <button class="btn primary block" type="submit">参加する</button>`}
          </form>
        </main>`;

      const form = document.getElementById('join-form');
      const here = document.getElementById('join-here');
      if (here) {
        here.addEventListener('click', () => {
          form.hidden = false;
          here.hidden = true;
          form.scrollIntoView({ behavior: 'smooth' });
        });
      }
      form.addEventListener('submit', async e => {
        e.preventDefault();
        busy(true, '参加しています…');
        try {
          let me = info.you;
          if (!info.you.joined) {
            const name = form.elements.display_name.value.trim();
            if (!name) throw new Error('表示名を入力してください');
            const res = await api('join', { token, display_name: name });
            me = res.me;
            saveSettings({ myName: name });
          }
          upsertSession({ token, album_id: info.album_id, album_name: info.album_name, member_id: me.member_id, display_name: me.display_name });
          sessionStorage.removeItem(INVITE_KEY);
          replaceHash(`#/a/${info.album_id}/list`);
        } catch (err) {
          toast(err.message, 4000);
        } finally {
          busy(false);
        }
      });
    })
    .catch(e => {
      $app.innerHTML = `${topbar('アルバムに参加', { back: '#/' })}<main class="page">
        ${e.code === 'invalid_token' ? `<div class="notice error"><p>${esc(e.message)}</p></div>` : errorBox(e.message)}</main>`;
    });
}

// ---------- アルバム（地図・一覧） ----------

// アルバムの中の画面（釣行・地図・一覧）の上のバー：左は「アルバム」一覧へ戻る、右は設定
function albumTopbar(albumId) {
  return `<header class="topbar album-bar">
    <span class="topbar-side"><a class="back-pill" href="#/" data-home aria-label="アルバムの一覧へ">${icon('back')}<span>アルバム</span></a></span>
    <h1>${esc(albumTitle(albumId))}</h1>
    <span class="topbar-side right"><a class="icon-btn" href="#/a/${esc(albumId)}/settings" aria-label="設定">${icon('settings')}</a></span>
  </header>`;
}

function tabbar(albumId, active) {
  const tab = (key, label, href) => `<a class="tab ${active === key ? 'active' : ''}" href="${href}" ${active === key ? 'aria-current="page"' : ''}>${icon(key)}<span>${label}</span></a>`;
  return `<nav class="tabbar">
    ${tab('trip', '釣行', `#/a/${albumId}/trip`)}
    ${tab('map', '地図', `#/a/${albumId}/map`)}
    ${tab('list', '一覧', `#/a/${albumId}/list`)}
    ${tab('tide', '潮表', `#/a/${albumId}/tide`)}
  </nav>`;
}

function catchThumb(albumId, c) {
  if (c._pending && c._previews && c._previews.length) return `<img src="${c._previews[0]}" alt="">`;
  if (c.photo_ids && c.photo_ids.length) return photoImg(c.photo_ids[0].t, 400);
  return `<div class="thumb-empty">${icon('camera')}</div>`;
}

// 潮位の文言：「111cm・上げ3分」。上げ○分／下げ○分は、干潮〜満潮（満潮〜干潮）の時間を10に分けて何分目か
function tideStage(r, t) {
  const { prev, next } = r;
  if (!prev || !next) return r.trend;
  const n = Math.round((t - prev.ms) / (next.ms - prev.ms) * 10);
  if (n <= 0) return prev.type;
  if (n >= 10) return next.type;
  return `${prev.type === '干潮' ? '上げ' : '下げ'}${n}分`;
}

function tideNowText(r, t) {
  const stage = tideStage(r, t);
  return `${r.level}cm${stage ? '・' + stage : ''}`;
}

// ---------- 潮位グラフ（詳細画面） ----------
const HOUR_MS = 3600000;

// グラフの範囲：釣行にひも付いていれば開始〜終了。無ければ写真の撮影時刻の最初〜最後（1枚なら前後6時間）、
// 撮影時刻も無ければ釣れた回の時刻の最初〜最後（1回なら前後6時間）。釣れた回がすべて入るように広げ、2時間より短ければ2時間にする
function tideChartRange(hs, trip) {
  const hitTimes = hs.map(h => Date.parse(h.at)).filter(isFinite);
  const photoTimes = hs.flatMap(h => h.photos || []).map(p => Date.parse(p.at)).filter(isFinite).sort((a, b) => a - b);
  if (!trip && !photoTimes.length && !hitTimes.length) return null; // 時刻が無ければグラフは出さない
  let from;
  let to;
  let basis;
  if (trip) {
    from = Date.parse(trip.started_at);
    to = trip.ended_at ? Date.parse(trip.ended_at) : Date.now();
    basis = '釣行の開始〜終了';
  } else if (photoTimes.length) {
    [from, to] = [photoTimes[0] - 6 * HOUR_MS, photoTimes[photoTimes.length - 1] + 6 * HOUR_MS];
    basis = photoTimes.length >= 2 ? '最初の写真の6時間前〜最後の写真の6時間後' : '写真の撮影時刻の前後6時間';
  } else {
    [from, to] = [Math.min(...hitTimes) - 6 * HOUR_MS, Math.max(...hitTimes) + 6 * HOUR_MS];
    basis = hitTimes.length >= 2 ? '最初に釣れた6時間前〜最後に釣れた6時間後' : '釣れた時刻の前後6時間';
  }
  from = Math.min(from, ...hitTimes);
  to = Math.max(to, ...hitTimes);
  if (to - from < 2 * HOUR_MS) {
    const mid = (from + to) / 2;
    [from, to] = [mid - HOUR_MS, mid + HOUR_MS];
  }
  return { from, to, basis };
}

// 潮位（線と薄い面）＋釣れた時刻（コーラルの点）。縦軸は1本（cm）、横軸は時刻（日本時間）
const CHART = { W: 340, H: 200, L: 40, R: 14, T: 22, B: 28 };
function tideChartSvg(series, marks, range) {
  const { W, H, L, R, T, B } = CHART;
  const values = [...series.points.map(p => p.h), ...marks.map(m => m.h)];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const step = hi - lo > 150 ? 50 : hi - lo > 60 ? 20 : 10;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (hi === lo) hi = lo + step;
  const y = h => T + (hi - h) / (hi - lo) * (H - T - B);
  // 干潮の文字（谷の下に書く）が線と重ならないよう、足りなければ下を広げる
  const lows = series.events.filter(e => e.type !== '満潮').map(e => e.h);
  for (let i = 0; i < 3 && lows.some(h => y(h) > H - B - 18); i++) lo -= step;
  const x = t => L + (t - range.from) / (range.to - range.from) * (W - L - R);
  const f = n => n.toFixed(1);

  const yTicks = [];
  for (let v = lo; v <= hi; v += step) yTicks.push(v);
  const span = (range.to - range.from) / HOUR_MS;
  const every = span <= 4 ? 1 : span <= 8 ? 2 : span <= 16 ? 3 : 6;
  const xTicks = [];
  const JST_MS = 9 * HOUR_MS;
  for (let t = Math.ceil((range.from + JST_MS) / (every * HOUR_MS)) * every * HOUR_MS - JST_MS; t <= range.to; t += every * HOUR_MS) xTicks.push(t);
  const tickLabel = t => {
    const d = new Date(t + JST_MS);
    return d.getUTCHours() === 0 ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : `${d.getUTCHours()}時`;
  };

  const line = series.points.map((p, i) => `${i ? 'L' : 'M'}${f(x(p.t))},${f(y(p.h))}`).join('');
  const base = H - B;
  const area = `${line}L${f(x(series.points[series.points.length - 1].t))},${base}L${f(x(series.points[0].t))},${base}Z`;
  const many = marks.length > 1;
  return `<svg class="tide-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="潮位のグラフ。釣れた時刻に印">
    <g class="tc-grid">${yTicks.map(v => `<line x1="${L}" x2="${W - R}" y1="${f(y(v))}" y2="${f(y(v))}"/>`).join('')}</g>
    <g class="tc-yl">${yTicks.map(v => `<text x="${L - 6}" y="${f(y(v) + 3.5)}">${v}</text>`).join('')}</g>
    <text class="tc-unit" x="${L - 6}" y="${T - 10}">cm</text>
    <g class="tc-xl">${xTicks.map(t => `<line x1="${f(x(t))}" x2="${f(x(t))}" y1="${base}" y2="${base + 4}"/><text x="${f(x(t))}" y="${base + 16}">${tickLabel(t)}</text>`).join('')}</g>
    <path class="tc-area" d="${area}"/>
    <path class="tc-line" d="${line}"/>
    <g class="tc-ev">${series.events.map(e => {
      // 満潮は線の上・干潮は線の下に。釣れた時刻の印（番号）と重なるときは、反対側に出す
      let up = e.type === '満潮';
      if (marks.some(m => Math.abs(x(m.t) - x(e.ms)) < 30)) up = !up;
      const ty = up ? y(e.h) - (e.type === '満潮' ? 7 : 8) : y(e.h) + 15;
      return `<text x="${f(x(e.ms))}" y="${f(Math.min(Math.max(ty, T - 6), base - 3))}">${e.type === '満潮' ? '満' : '干'} ${jstTime(e.ms)}</text>`;
    }).join('')}</g>
    <g class="tc-marks">${marks.map((m, i) => `<circle cx="${f(x(m.t))}" cy="${f(y(m.h))}" r="5"/>${many ? `<text x="${f(x(m.t))}" y="${f(y(m.h) - 9)}">${i + 1}</text>` : ''}`).join('')}</g>
    <g class="tc-cross" hidden><line y1="${T}" y2="${base}"/><circle r="4"/></g>
    <rect class="tc-hit" x="${L}" y="${T - 12}" width="${W - L - R}" height="${base - T + 12}"/>
  </svg>`;
}

// 指でなぞると、その時刻の潮位を出す（釣れた時刻の近くでは、その回を出す）
function bindTideChart(wrap, series, marks, range) {
  const svg = wrap.querySelector('svg');
  const tip = wrap.querySelector('.tg-tip');
  const cross = svg.querySelector('.tc-cross');
  const { W, H, L, R, T, B } = CHART;
  const values = [...series.points.map(p => p.h), ...marks.map(m => m.h)];
  const step = Math.max(...values) - Math.min(...values) > 150 ? 50 : Math.max(...values) - Math.min(...values) > 60 ? 20 : 10;
  const lo = Math.floor(Math.min(...values) / step) * step;
  let hi = Math.ceil(Math.max(...values) / step) * step;
  if (hi === lo) hi = lo + step;
  const toX = t => L + (t - range.from) / (range.to - range.from) * (W - L - R);
  const toY = h => T + (hi - h) / (hi - lo) * (H - T - B);
  function show(e) {
    const box = svg.getBoundingClientRect();
    const sx = (e.clientX - box.left) * W / box.width;
    let t = range.from + (Math.min(Math.max(sx, L), W - R) - L) / (W - L - R) * (range.to - range.from);
    const near = marks.find(m => Math.abs(toX(m.t) - sx) <= 12);
    if (near) t = near.t;
    const h = series.levelAt(t);
    if (h == null) return;
    cross.hidden = false;
    cross.querySelector('line').setAttribute('x1', toX(t));
    cross.querySelector('line').setAttribute('x2', toX(t));
    cross.querySelector('circle').setAttribute('cx', toX(t));
    cross.querySelector('circle').setAttribute('cy', toY(h));
    tip.hidden = false;
    tip.textContent = `${near && marks.length > 1 ? `${marks.indexOf(near) + 1}回目 ` : near ? '釣れた時刻 ' : ''}${jstTime(t)}　${Math.round(h)}cm`;
    const px = toX(t) / W * box.width;
    tip.style.left = `${Math.min(Math.max(px, 60), box.width - 60)}px`;
  }
  const hit = svg.querySelector('.tc-hit');
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { cross.hidden = true; tip.hidden = true; } });
}

function tideChartCardHtml(series, marks, range) {
  const list = type => series.events.filter(e => e.type === type).map(e => `${jstTime(e.ms)}（${e.h}cm）`).join('　') || 'なし';
  const d = new Date(range.from);
  const e = new Date(range.to);
  return `<h2>潮位グラフ <span class="muted small">（予測）</span></h2>
    <div class="tg-legend"><span><i class="lg-line"></i>潮位</span><span><i class="lg-dot"></i>釣れた時刻</span></div>
    <div class="tg-wrap">${tideChartSvg(series, marks, range)}<div class="tg-tip" hidden></div></div>
    <p class="muted small">範囲：${esc(range.basis)}（${d.getMonth() + 1}/${d.getDate()} ${esc(jstTime(range.from))}〜${e.toDateString() !== d.toDateString() ? `${e.getMonth() + 1}/${e.getDate()} ` : ''}${esc(jstTime(range.to))}）。グラフをなぞると、その時刻の潮位が出ます。</p>
    <dl class="fields"><dt>満潮</dt><dd>${esc(list('満潮'))}</dd><dt>干潮</dt><dd>${esc(list('干潮'))}</dd></dl>
    <p class="muted small">${esc(series.station.name)}（約${Math.round(series.km)}km）の予測です。出典：気象庁「潮位表」。川の上流などでは時刻が遅れることがあります。</p>`;
}

// 回ごとに持つ項目（位置・場所名だけは釣果全体で1つ）
const HIT_FIELDS = ['species', 'size_cm', 'weight_g', 'angler_member_id', 'tide_name', 'method', 'bait', 'memo'];

// 釣れた回（時刻・匹数・写真・魚種・サイズ・潮・タックル・メモ）。
// hits の無い釣果は「日時に匹数ぶん」の1回とみなす。回ごとの項目が無い古い釣果は、釣果の値を回に写す
// （サイズ・重さ・メモは最初の回だけ）。回ごとの写真が無いときは、写真をすべて最初の回に付ける
function hitsOf(c) {
  const photos = c.photo_ids || [];
  const fromCatch = i => ({
    species: c.species, angler_member_id: c.angler_member_id, tide_name: c.tide_name, method: c.method, bait: c.bait,
    size_cm: i === 0 ? c.size_cm : null, weight_g: i === 0 ? c.weight_g : null, memo: i === 0 ? c.memo : ''
  });
  if (!Array.isArray(c.hits) || !c.hits.length) return [{ at: c.caught_at, count: c.count || 1, photos, ...fromCatch(0) }];
  const perHit = c.hits.some(h => Array.isArray(h.photos));
  const full = c.hits.some(h => h.species !== undefined);
  return c.hits.map((h, i) => ({ ...(full ? {} : fromCatch(i)), ...h, photos: perHit ? (h.photos || []) : (i === 0 ? photos : []) }));
}

const hasValue = v => v !== '' && v != null;

// 回から、釣果全体の値（一覧・地図・古い画面用）を作る。GAS の cleanCatch_ と同じ決め方：
// 日時＝最初の回、匹数＝合計、魚種＝重ならないように「・」でつなぐ、サイズ・重さ＝最大、そのほか＝最初の回
function summarizeHits(hits) {
  const first = hits[0];
  const max = key => {
    const v = hits.map(h => h[key]).filter(hasValue).map(Number);
    return v.length ? Math.max(...v) : '';
  };
  return {
    caught_at: first.at,
    count: hits.reduce((n, h) => n + Number(h.count), 0),
    species: [...new Set(hits.map(h => h.species).filter(Boolean))].join('・').slice(0, 50),
    size_cm: max('size_cm'),
    weight_g: max('weight_g'),
    angler_member_id: first.angler_member_id,
    tide_name: first.tide_name,
    method: first.method,
    bait: first.bait,
    memo: first.memo
  };
}

// アップロードした写真の ID を、回ごとの枚数（counts）に合わせて各回に分ける
function withHitPhotos(hits, ids, counts) {
  let k = 0;
  return hits.map((h, i) => ({ ...h, photos: ids.slice(k, (k += counts[i] || 0)) }));
}

// 「9:40」、日付が違えば「9/28 0:40」
function fmtHitTime(iso, baseIso) {
  const d = new Date(iso);
  const b = new Date(baseIso);
  const hm = `${d.getHours()}:${pad(d.getMinutes())}`;
  return d.toDateString() === b.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function catchSummary(c) {
  const bits = [];
  const many = hitsOf(c).length > 1 ? '最大' : ''; // 回が複数なら、サイズ・重さは最大の値
  if (hasValue(c.size_cm)) bits.push(`${many}${c.size_cm}cm`);
  if (hasValue(c.weight_g)) bits.push(`${many}${c.weight_g}g`);
  if (c.count > 1) bits.push(`${c.count}匹`);
  return bits.join('・');
}

// 下書きの続きを入れる画面（端末だけの下書きは新規登録、送った下書きは編集）
function draftHref(albumId, c) {
  return c._localDraft ? `#/a/${albumId}/new?draft=${c.catch_id}` : `#/a/${albumId}/c/${c.catch_id}/edit`;
}

function catchCard(albumId, c) {
  const status = c._pending === 'sending' ? '<span class="chip">送信中…</span>'
    : c._pending === 'error' ? `<span class="chip error">送信失敗</span>`
    : c.draft ? `<span class="chip draft">下書き${c._localDraft ? '（釣行の終了時に送信）' : ''}</span>` : '';
  const body = `
    <div class="catch-thumb">${catchThumb(albumId, c)}</div>
    <div class="catch-body">
      <h3>${c.species ? esc(c.species) : '<span class="muted">魚種はまだ</span>'} <span class="size">${esc(catchSummary(c))}</span></h3>
      <p class="muted">${esc(c.place_name || '場所名なし')}</p>
      <p class="muted small">${esc(fmtDateTime(c.caught_at))}${hitsOf(c).length > 1 ? '〜' + esc(fmtHitTime(hitsOf(c).at(-1).at, c.caught_at)) : ''}・${esc(memberName(albumId, c.angler_member_id))}</p>
      ${status}${locSourceChip(c)}
      ${c._pending === 'error' ? `<p class="small error-text">${esc(c._error || '')}</p>
        <div class="row"><button class="btn small" data-retry="${esc(c.catch_id)}">再送する</button>
        <button class="btn small text" data-discard="${esc(c.catch_id)}">取り消す</button></div>` : ''}
    </div>`;
  if (c._pending) return `<div class="catch-card pending">${body}</div>`;
  if (c._localDraft) return `<a class="catch-card draft" href="${esc(draftHref(albumId, c))}">${body}</a>`;
  return `<a class="catch-card${c.draft ? ' draft' : ''}" href="#/a/${esc(albumId)}/c/${esc(c.catch_id)}">${body}</a>`;
}

let lastMapView = {}; // アルバムごとの地図の表示位置（タブを行き来しても保つ）

function viewAlbum(albumId, tab) {
  const st = stateOf(albumId);
  $app.innerHTML = `${albumTopbar(albumId)}
    <main class="${tab === 'map' ? 'map-page' : 'page with-tabbar'}" id="album-main"></main>
    <a class="fab${tab === 'map' ? ' on-map' : ''}" href="#/a/${esc(albumId)}/new" aria-label="釣果を登録">${icon('plus')}</a>
    ${tabbar(albumId, tab)}`;
  const main = document.getElementById('album-main');

  if (tab === 'list') {
    const drawList = () => {
      const list = catchesOf(albumId);
      let html = '';
      if (st.error && st.error.code === 'invalid_token') html += invalidTokenBox(albumId);
      else if (st.error) html += `<div class="notice error"><p>${esc(st.error.message)}</p><button class="btn small" data-action="reload">もう一度読み込む</button></div>`;
      if (!st.data && st.loading) {
        html += '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
      } else if (!list.length && st.data) {
        html += `<div class="empty"><p>まだ釣果がありません。</p><a class="btn primary" href="#/a/${esc(albumId)}/new">最初の釣果を登録する</a></div>`;
      } else {
        html += `<div class="catch-list">${list.map(c => catchCard(albumId, c)).join('')}</div>`;
      }
      main.innerHTML = html;
      document.querySelector('.topbar h1').textContent = albumTitle(albumId);
    };
    current.refresh = drawList;
    drawList();
  } else {
    if (!mapReady()) {
      main.innerHTML = errorBox('地図の部品を読み込めませんでした。電波の良い所で開き直してください。');
    } else {
      main.innerHTML = `<div id="map" class="map-full"></div>
        <p class="map-hint">地図を長押しすると、その場所で釣果を登録できます</p>
        <div class="route-panel" id="route-panel" hidden></div>`;
      const panel = document.getElementById('route-panel');
      const cm = createCatchMap(document.getElementById('map'), {
        onRouteButton: () => { panel.hidden = !panel.hidden; if (!panel.hidden) drawPanel(); },
        layerKey: getSettings().layer,
        catches: catchesOf(albumId),
        view: lastMapView[albumId],
        colorOf: c => memberIndex(albumId, c.angler_member_id),
        popupHtml: c => mapPopup(albumId, c),
        onLongPress: (latlng, { touching }) => {
          if (touching) guardSelection();
          location.hash = `#/a/${albumId}/new?lat=${latlng.lat.toFixed(6)}&lng=${latlng.lng.toFixed(6)}`;
        },
        onError: msg => toast(msg, 4000)
      });

      // 釣行のルート：表示する釣行は端末に記憶（最初はすべて非表示）
      const shown = new Set(getRouteShown(albumId));
      // 色は古い釣行から順に割り当てる（新しい釣行が増えても、前の釣行の色が変わらないように）
      const tripColor = t => {
        const list = tripsOf(albumId);
        return ROUTE_COLORS[(list.length - 1 - list.indexOf(t)) % ROUTE_COLORS.length];
      };
      const routeLatLngs = t => (t.points || []).map(p => [p.lat, p.lng]);
      const drawRoutes = () => cm.setRoutes(tripsOf(albumId).filter(t => shown.has(t.trip_id)).map(t => ({ id: t.trip_id, color: tripColor(t), latlngs: routeLatLngs(t) })));
      // 釣行が全部入る倍率にする（ルートと、その釣行の釣果）
      const fitTrip = t => cm.fitTo([...routeLatLngs(t), ...catchesOf(albumId).filter(c => c.trip_id === t.trip_id).map(c => [c.lat, c.lng])]);
      function drawPanel() {
        const trips = tripsOf(albumId);
        panel.innerHTML = `<div class="route-head"><b>釣行のルート</b><button class="icon-btn" data-close aria-label="閉じる">${icon('x')}</button></div>
          ${trips.length ? trips.map(t => `<label class="route-item">
            <input type="checkbox" data-trip="${esc(t.trip_id)}" ${shown.has(t.trip_id) ? 'checked' : ''}>
            <span class="route-swatch" style="background:${tripColor(t)}"></span>
            <span class="grow">${esc(tripTitle(albumId, t))}</span>
            ${t.member_id === sessionFor(albumId).member_id && !t._unsent ? `<button type="button" class="btn small text" data-del-trip="${esc(t.trip_id)}">削除</button>` : ''}</label>`).join('') : '<p class="muted small">まだ釣行がありません。「釣行」タブから開始できます。</p>'}`;
      }
      panel.addEventListener('click', async e => {
        if (e.target.closest('[data-close]')) panel.hidden = true;
        const del = e.target.closest('[data-del-trip]');
        if (!del) return;
        e.preventDefault(); // チェックボックスを切り替えない
        const id = del.dataset.delTrip;
        if (!confirm('この釣行を削除しますか？（釣果は消えません。ルートとひも付けが消えます）')) return;
        busy(true, '削除しています…');
        try {
          await api('deleteTrip', { token: sessionFor(albumId).token, trip_id: id });
          st.data.trips = st.data.trips.filter(t => t.trip_id !== id);
          st.data.catches.forEach(c => { if (c.trip_id === id) c.trip_id = ''; });
          saveStateCache(albumId);
          shown.delete(id);
          setRouteShown(albumId, [...shown]);
          drawRoutes();
          drawPanel();
          toast('削除しました');
        } catch (err) {
          toast(err.message, 4000);
        } finally {
          busy(false);
        }
      });
      panel.addEventListener('change', e => {
        const id = e.target.dataset.trip;
        if (!id) return;
        if (e.target.checked) shown.add(id); else shown.delete(id);
        setRouteShown(albumId, [...shown]);
        drawRoutes();
        const t = tripsOf(albumId).find(x => x.trip_id === id);
        if (e.target.checked && t) fitTrip(t);
      });
      // 詳細画面の「釣行のルートを見る」から来たとき（?trip=）
      const focus = parseRoute().params.get('trip');
      let focused = false;
      const focusTrip = () => {
        const t = focus && !focused && tripsOf(albumId).find(x => x.trip_id === focus);
        if (!t) return;
        focused = true;
        shown.add(t.trip_id);
        setRouteShown(albumId, [...shown]);
        drawRoutes();
        fitTrip(t);
      };
      drawRoutes();
      focusTrip();

      current.refresh = () => {
        cm.setCatches(catchesOf(albumId));
        drawRoutes();
        focusTrip();
        if (!panel.hidden) drawPanel();
        if (st.error) toast(st.error.message, 4000);
      };
      current.cleanup = () => {
        lastMapView[albumId] = cm.getView();
        cm.remove();
      };
      setTimeout(() => {
        const hint = main.querySelector('.map-hint');
        if (hint) hint.classList.add('fade');
      }, 4000);
    }
  }
  refreshAlbum(albumId);
}

const NEARBY_M = 30; // 「同じ地点」とみなす半径

function mapPopup(albumId, c) {
  const div = document.createElement('div');
  div.className = 'popup';
  const href = c._localDraft || c.draft ? draftHref(albumId, c) : `#/a/${albumId}/c/${c.catch_id}`;
  const nearby = catchesOf(albumId).filter(x => x !== c && !x._pending && isFinite(x.lat) && distanceM(c, x) <= NEARBY_M);
  const place = c.place_name || (nearby.find(x => x.place_name) || {}).place_name || '';
  const addHref = `#/a/${albumId}/new?lat=${Number(c.lat).toFixed(6)}&lng=${Number(c.lng).toFixed(6)}${place ? '&place=' + encodeURIComponent(place) : ''}`;
  div.innerHTML = `
    <div class="popup-thumb">${catchThumb(albumId, c)}</div>
    <b>${c.species ? esc(c.species) : '（下書き）'}</b> ${esc(catchSummary(c))}<br>
    <span class="muted small">${esc(fmtDate(c.caught_at))}・${esc(memberName(albumId, c.angler_member_id))}</span>
    ${c._pending ? '<br><span class="chip">送信中</span>' : `<br><a class="btn small" href="${esc(href)}">${c.draft ? '続きを入力' : '詳細を見る'}</a>`}
    ${nearby.length ? `<div class="popup-nearby"><p class="muted small">この地点（${NEARBY_M}m以内）の釣果 ${nearby.length}件</p>
      ${nearby.slice(0, 5).map(x => `<a class="nearby-item" href="${esc(x._localDraft || x.draft ? draftHref(albumId, x) : `#/a/${albumId}/c/${x.catch_id}`)}">
        <span>${esc(fmtDate(x.caught_at))}</span> <b>${x.species ? esc(x.species) : '下書き'}</b> <span class="muted">${esc(catchSummary(x))}</span></a>`).join('')}
      ${nearby.length > 5 ? `<p class="muted small">ほか${nearby.length - 5}件</p>` : ''}</div>` : ''}
    <a class="btn small primary add-here" href="${esc(addHref)}">${icon('plus')} この地点で追加</a>`;
  return div;
}

// 地図に表示する釣行のルート（端末に記憶）
function getRouteShown(albumId) {
  try { return JSON.parse(localStorage.getItem('tr.routes.' + albumId) || '[]'); } catch (e) { return []; }
}
function setRouteShown(albumId, ids) {
  try { localStorage.setItem('tr.routes.' + albumId, JSON.stringify(ids)); } catch (e) { /* 保存できなくても続ける */ }
}

// 「9/27（土）4:30〜7:10・ひろ・3匹」
function tripTitle(albumId, t) {
  const s = new Date(t.started_at);
  const e = t.ended_at ? new Date(t.ended_at) : null;
  const wd = '日月火水木金土'[s.getDay()];
  const hm = d => `${d.getHours()}:${pad(d.getMinutes())}`;
  const count = catchesOf(albumId).filter(c => c.trip_id === t.trip_id).reduce((n, c) => n + (Number(c.count) || 1), 0);
  return `${s.getMonth() + 1}/${s.getDate()}（${wd}）${hm(s)}〜${e ? hm(e) : ''}・${memberName(albumId, t.member_id) || '自分'}・${count}匹`;
}

// ---------- 釣果の新規登録（楽観的更新） ----------

$app.addEventListener('click', e => {
  const r = e.target.closest('[data-retry]');
  if (r && current.albumId) {
    e.preventDefault();
    const p = stateOf(current.albumId).pending.find(x => x.catch_id === r.dataset.retry);
    if (p) sendPending(current.albumId, p);
    return;
  }
  const d = e.target.closest('[data-discard]');
  if (d && current.albumId && confirm('この釣果の登録を取り消しますか？')) {
    e.preventDefault();
    const st = stateOf(current.albumId);
    const p = st.pending.find(x => x.catch_id === d.dataset.discard);
    if (p) (p._previews || []).forEach(u => URL.revokeObjectURL(u));
    st.pending = st.pending.filter(x => x.catch_id !== d.dataset.discard);
    notify(current.albumId);
  }
});

window.addEventListener('beforeunload', e => {
  const sending = Object.values(albumState).some(st => st.pending.some(p => p._pending === 'sending'));
  if (sending) {
    e.preventDefault();
    e.returnValue = '';
  }
});

async function uploadPhotos(token, photos, done) {
  // done：アップロード済みの {f,t}（再送時に同じ写真を二重に送らないため）
  const ids = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    if (p.kind === 'existing') {
      ids.push(p.at ? { f: p.f, t: p.t, at: p.at } : { f: p.f, t: p.t });
      continue;
    }
    if (done && done[i]) {
      ids.push(done[i]);
      continue;
    }
    const res = await api('uploadPhoto', {
      token,
      full: await blobToBase64(p.full),
      thumb: await blobToBase64(p.thumb)
    }, { timeout: 120000 });
    // 撮影時刻（あれば）も一緒に持つ（潮位グラフの範囲に使う）
    const photo = p.takenAt ? { ...res.photo, at: toLocalIso(p.takenAt) } : res.photo;
    ids.push(photo);
    if (done) done[i] = photo;
  }
  return ids;
}

async function sendPending(albumId, p) {
  const st = stateOf(albumId);
  const session = sessionFor(albumId);
  p._pending = 'sending';
  p._error = '';
  notify(albumId);
  try {
    const photoIds = await uploadPhotos(session.token, p._photos, p._uploaded);
    const { catch_id, _pending, _error, _photos, _uploaded, _previews, _photoCounts, ...fields } = p;
    const hits = withHitPhotos(fields.hits, photoIds, _photoCounts);
    const res = await api('saveCatch', { token: session.token, catch: { ...fields, hits, photo_ids: photoIds } });
    st.pending = st.pending.filter(x => x !== p);
    (p._previews || []).forEach(u => URL.revokeObjectURL(u));
    if (st.data) {
      st.data.catches.push(res.catch);
      saveStateCache(albumId);
    }
    toast('登録しました');
    refreshAlbum(albumId);
  } catch (e) {
    p._pending = 'error';
    p._error = e.message;
    toast('送信に失敗しました。一覧の「再送する」を押してください', 4000);
  }
  notify(albumId);
}

// ---------- 登録・編集フォーム ----------

function viewForm(albumId, catchId, params) {
  const st = stateOf(albumId);
  const session = sessionFor(albumId);
  const settings = getSettings();
  const editing = !!catchId;
  const orig = editing && st.data ? st.data.catches.find(c => c.catch_id === catchId) : null;

  if (editing && !orig) {
    $app.innerHTML = `${topbar('編集', { back: `#/a/${albumId}/list` })}<main class="page">
      ${st.data ? errorBox('この釣果は見つかりません（削除された可能性があります）', false) : '<div class="skeleton-card"></div>'}</main>`;
    if (!st.data) {
      current.refresh = () => render();
      refreshAlbum(albumId);
    }
    return;
  }
  if (!st.data) {
    // 初めて開くアルバムで、まだメンバーがわからないときは読み込みを待つ
    $app.innerHTML = `${topbar('釣果を登録', { back: `#/a/${albumId}/list` })}<main class="page"><div class="skeleton-card"></div></main>`;
    current.refresh = () => { if (stateOf(albumId).data) render(); else if (st.error) $app.querySelector('main').innerHTML = errorBox(st.error.message); };
    refreshAlbum(albumId);
    return;
  }

  // 「釣れた！」の下書き（端末だけにあるもの）の続きを入れるとき
  const localDraft = !editing && params.get('draft') ? localDrafts(albumId).find(d => d.catch_id === params.get('draft')) : null;
  // 位置：編集なら元の値、下書きならその地点、長押し・「この地点で追加」から来たならその座標、それ以外は未設定（釣果全体で1つ）
  let loc = null;
  if (orig) loc = { lat: orig.lat, lng: orig.lng };
  else if (localDraft) loc = { lat: localDraft.lat, lng: localDraft.lng };
  else if (params.get('lat') && params.get('lng')) loc = parseLatLng(`${params.get('lat')},${params.get('lng')}`);
  // 位置の出どころ：button（釣れた！）／estimated（撮影時刻から推定）／manual（手動）。
  // 優先順は button ＞ estimated ＞ manual。自動の推定は、button のときと、この画面で自分で位置を決めたときはしない
  let locSource = orig ? (orig.loc_source || '') : localDraft ? 'button' : loc ? 'manual' : '';
  let locDecided = editing && orig.loc_source !== 'estimated'; // 前に決めた位置は、推定で上書きしない
  const lastCatch = catchesOf(albumId).find(c => isFinite(c.lat));
  // 釣れた回。1回ごとに時刻・匹数・写真（5枚まで）・魚種・サイズ・釣った人・潮・タックル・メモを持つ。
  // 時刻順に並べ、最初の回＝釣果の日時。
  // usePhoto：時刻を写真の撮影日時から入れる（回ごとのトグル。既定はオン。写真があればその回の時刻は変更不可）。
  // tideTouched：潮を手で選んだ（自動で変えない）。tideAt：潮名を決めたときの時刻（編集では保存済みの潮を、時刻を変えるまで残す）。
  // uid：回の目印。入力欄とは並び順ではなく uid で結びつける（並べ替え中に古い欄の値が別の回に入らないように）
  let uidSeq = 0;
  const hits = (orig ? hitsOf(orig) : [{ at: localDraft ? localDraft.caught_at : new Date().toISOString(), count: 1, photos: [], angler_member_id: session.member_id }])
    .map(h => ({
      at: toLocalInput(new Date(h.at)),
      count: h.count,
      photos: (h.photos || []).map(p => ({ kind: 'existing', f: p.f, t: p.t, at: p.at })),
      ...Object.fromEntries(HIT_FIELDS.map(k => [k, h[k] ?? ''])),
      usePhoto: true,
      tideTouched: false,
      tideAt: editing ? toLocalInput(new Date(h.at)) : null,
      uid: ++uidSeq
    }));
  const hitBy = uid => hits.find(h => h.uid === Number(uid));
  let dirty = false;

  const members = st.data.members;
  // 魚種の候補（これまでの釣果から）
  const speciesList = [...new Set(catchesOf(albumId).flatMap(c => hitsOf(c).map(h => h.species)).filter(Boolean))];
  const title = editing ? '釣果を編集' : '釣果を登録';
  const back = editing ? `#/a/${albumId}/c/${catchId}` : `#/a/${albumId}/list`;

  $app.innerHTML = `${topbar(title, { back })}
    <main class="page">
      <form id="catch-form" class="form" novalidate>
        <div id="hits"></div>
        <button class="btn block" type="button" id="hit-add">${icon('plus')} 釣れた回を追加</button>
        <p class="muted small add-note">時間をあけて釣れたときは回を分けて記録できます（前の回の魚種・タックルを引き継ぎます）。時刻の順に自動で並べ替えます。写真は1回につき${MAX_PHOTOS}枚まで。写真の位置情報は使わず、保存もしません。</p>

        <section class="card">
          <h2>釣り場 <span class="req">必須</span> <span class="muted small">（全部の回で共通）</span></h2>
          <p class="loc-src-line" id="loc-src"></p>
          <div id="picker" class="picker-map"></div>
          <p class="muted small">地図をタップするとピンが立ちます。ピンはドラッグで動かせます。</p>
          <div class="row">
            <button class="btn" type="button" id="locate-btn">${icon('pin')} 現在地</button>
            <a class="btn" id="gmaps-link" target="_blank" rel="noopener">Googleマップで開く</a>
          </div>
          <label>緯度, 経度（貼り付けOK）
            <input name="coord" inputmode="decimal" placeholder="35.123456, 138.123456" autocomplete="off">
          </label>
          <label>場所名<input name="place_name" maxlength="100" value="${esc(orig ? orig.place_name : params.get('place') || '')}" placeholder="例：〇〇港 赤灯台"></label>
        </section>

        <datalist id="species-list">${speciesList.map(sp => `<option value="${esc(sp)}">`).join('')}</datalist>
        <button class="btn primary block big" type="submit">${editing ? '保存する' : '登録する'}</button>
      </form>
    </main>`;

  const form = document.getElementById('catch-form');
  const coord = form.elements.coord;
  const gmaps = document.getElementById('gmaps-link');
  const hitsEl = document.getElementById('hits');
  const created = []; // この画面で作ったプレビューURL（画面を閉じたら解放）

  form.addEventListener('input', () => { dirty = true; });

  // その回の写真の撮影日時（いちばん早いもの）。撮影日時の無い写真だけなら null
  // （新しく選んだ写真の撮影日時と、保存済みの写真の撮影時刻から）
  const photoTime = h => h.photos.map(p => (p.kind === 'new' ? p.takenAt : p.at ? new Date(p.at) : null))
    .filter(d => d && !isNaN(d)).sort((a, b) => a - b)[0] || null;
  const locked = h => h.usePhoto && !!photoTime(h);
  // 時刻の下の一言
  const timeNote = h => {
    if (!h.usePhoto) return '時刻を自分で入れます';
    if (photoTime(h)) return '写真の撮影日時を使っています';
    return h.photos.length ? '写真に撮影日時が無いため、自分で入れてください' : '写真を選ぶと撮影日時が入ります';
  };

  // ---------- 回のカード ----------
  let moved = []; // 並べ替えで動いた回（光らせる）
  function hitCard(h, i, many) {
    const f = key => `data-uid="${h.uid}" data-f="${key}"`;
    return `<section class="card hit-card${moved[i] ? ' moved' : ''}" data-hit="${h.uid}">
      <div class="hit-head">
        <h2>${many ? `${i + 1}回目` : '釣果'}</h2>
        ${many ? `<button type="button" class="icon-btn hit-del" data-del-hit="${h.uid}" aria-label="${i + 1}回目を消す">${icon('x')}</button>` : ''}
      </div>
      <div class="hit-photos">
        ${h.photos.map((p, j) => `<div class="photo-item">
          ${p.kind === 'existing' ? photoImg(p.t, 400) : `<img src="${p.previewUrl}" alt="">`}
          <button type="button" class="photo-del" data-del-photo="${h.uid}:${j}" aria-label="写真を外す">${icon('x')}</button></div>`).join('')}
        ${h.photos.length < MAX_PHOTOS ? `<label class="photo-add-tile" aria-label="写真を撮る・選ぶ">${icon('camera')}<span>写真</span>
          <input type="file" accept="image/*" multiple hidden data-photo-input="${h.uid}"></label>` : ''}
      </div>
      <div class="hit-time">
        <div class="time-field">
          <div class="time-head">
            <span class="field-label">時刻 <span class="req">必須</span></span>
            <label class="switch"><input type="checkbox" data-photo-toggle="${h.uid}" ${h.usePhoto ? 'checked' : ''}><span class="switch-track"></span>写真から入力</label>
          </div>
          <input type="datetime-local" class="hit-at" aria-label="時刻" ${f('at')} value="${esc(h.at)}" ${locked(h) ? 'disabled' : ''}>
          <p class="time-note">${esc(timeNote(h))}</p>
        </div>
        <label class="count-field"><span class="time-head"><span class="field-label">匹数</span></span><input type="number" inputmode="numeric" min="1" step="1" ${f('count')} value="${esc(h.count)}"></label>
      </div>
      <label>魚種 <span class="req">必須</span><input maxlength="50" list="species-list" ${f('species')} value="${esc(h.species)}" placeholder="例：アジ"></label>
      <div class="grid2">
        <label>サイズ(cm)<input type="number" inputmode="decimal" min="0" step="0.1" ${f('size_cm')} value="${esc(h.size_cm)}"></label>
        <label>重さ(g)<input type="number" inputmode="decimal" min="0" step="1" ${f('weight_g')} value="${esc(h.weight_g)}"></label>
      </div>
      <label>釣った人
        <select ${f('angler_member_id')}>${members.map(m => `<option value="${esc(m.member_id)}" ${m.member_id === h.angler_member_id ? 'selected' : ''}>${esc(m.display_name || '（未参加）')}</option>`).join('')}</select>
      </label>
      <div class="grid2 tide-row">
        <label>潮
          <select ${f('tide_name')}><option value="">（未選択）</option>${TIDES.map(t => `<option ${h.tide_name === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>
        <div class="tide-level-field"><span class="field-label">潮位（気象庁の予測）</span><div class="readout" data-tide-level>ー</div></div>
      </div>
      <p class="muted small tide-hint" data-tide-hint></p>
      <label>釣り方・仕掛け<input maxlength="100" ${f('method')} value="${esc(h.method)}"></label>
      <label>エサ／ルアー<input maxlength="100" ${f('bait')} value="${esc(h.bait)}"></label>
      <label>メモ<textarea maxlength="2000" rows="2" ${f('memo')}>${esc(h.memo)}</textarea></label>
    </section>`;
  }

  // 描き直しの間に起きる change・focusout（入力中の欄が消えるときに出る）は無視する。
  // 値は描き直す前に readHits で取り込み済みなので、古い欄の値で上書きしないように
  let redrawing = false;
  function drawHits() {
    const many = hits.length > 1;
    redrawing = true;
    try {
      if (hitsEl.contains(document.activeElement)) document.activeElement.blur();
      hitsEl.innerHTML = hits.map((h, i) => hitCard(h, i, many)).join('')
        + (many ? `<p class="hit-total">合計 <b>${hits.reduce((n, h) => n + (Number(h.count) || 0), 0)}</b>匹（${hits.length}回）</p>` : '');
    } finally {
      redrawing = false;
    }
    hits.forEach(syncTide);
  }

  // 入力欄の今の値を取り込む（描き直す前に。確定前の入力を消さないように）
  function readHits() {
    hitsEl.querySelectorAll('[data-f]').forEach(el => {
      const h = hitBy(el.dataset.uid);
      // 写真から入れた時刻（変更不可）は入力欄から読まない
      if (!h || (el.dataset.f === 'at' && (!el.value || locked(h)))) return;
      h[el.dataset.f] = el.value;
    });
  }

  // 時刻の順に並べる。並びが変わったら知らせて、動いた回を光らせる
  function sortHits() {
    const before = hits.slice();
    hits.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    moved = hits.map((h, i) => before[i] !== h);
    if (moved.some(Boolean)) toast('時刻の順に並べ替えました');
  }

  // 並べ替えは、回のカードから離れたとき（同じ回の続きを入れている途中で動かないように）
  let needSort = false;
  // 同じカードの中を押した（トグル・ラベルなど、フォーカスを受けない所も）なら、まだ並べ替えない。
  // ここで描き直すと、押した部品が消えてタップが効かなくなるため
  let pressedCard = null;
  hitsEl.addEventListener('pointerdown', e => { pressedCard = e.target.closest('[data-hit]'); }, true);
  hitsEl.addEventListener('focusout', e => {
    if (redrawing || !needSort) return;
    const from = e.target.closest('[data-hit]');
    if (from && (from.contains(e.relatedTarget) || from === pressedCard)) return;
    needSort = false;
    readHits();
    sortHits();
    drawHits();
    moved = [];
  });

  hitsEl.addEventListener('change', e => {
    if (redrawing) return;
    const t = e.target;
    if (t.dataset.photoInput !== undefined) return addPhotos(hitBy(t.dataset.photoInput), t);
    if (t.dataset.photoToggle !== undefined) {
      readHits();
      hitBy(t.dataset.photoToggle).usePhoto = t.checked;
      dirty = true;
      syncDate();
      return;
    }
    readHits();
    const h = hitBy(t.dataset.uid);
    if (!h) return;
    if (t.dataset.f === 'at') {
      needSort = true;
      syncTide(h);
    } else if (t.dataset.f === 'tide_name') {
      h.tideTouched = true;
      syncTide(h);
    } else if (t.dataset.f === 'count') {
      const total = hitsEl.querySelector('.hit-total b');
      if (total) total.textContent = hits.reduce((n, x) => n + (Number(x.count) || 0), 0);
    }
  });

  hitsEl.addEventListener('click', e => {
    const dp = e.target.closest('[data-del-photo]');
    if (dp) {
      readHits();
      const [uid, j] = dp.dataset.delPhoto.split(':');
      hitBy(uid).photos.splice(Number(j), 1);
      dirty = true;
      syncDate();
      return;
    }
    const d = e.target.closest('[data-del-hit]');
    if (!d) return;
    const h = hitBy(d.dataset.delHit);
    const i = hits.indexOf(h);
    if (!confirm(`${i + 1}回目の記録${h.photos.length ? '（写真も）' : ''}を消しますか？`)) return;
    readHits();
    hits.splice(i, 1);
    dirty = true;
    drawHits(); // 消した回の入力欄を読み直さないよう、先に描き直す
    syncDate();
  });

  // 回を足す：前の回の魚種・釣った人・潮・タックルを引き継ぐ（サイズ・重さ・メモ・写真は空）
  document.getElementById('hit-add').addEventListener('click', () => {
    readHits();
    sortHits();
    needSort = false;
    const last = hits[hits.length - 1];
    hits.push({
      at: last.at, count: 1, photos: [],
      species: last.species, size_cm: '', weight_g: '', angler_member_id: last.angler_member_id,
      tide_name: last.tide_name, method: last.method, bait: last.bait, memo: '',
      usePhoto: last.usePhoto, tideTouched: last.tideTouched, tideAt: last.tideAt, uid: ++uidSeq
    });
    dirty = true;
    drawHits();
    moved = [];
    hitsEl.lastElementChild.previousElementSibling.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // 回に写真を足す（1回につき MAX_PHOTOS 枚まで）。「写真から」なら撮影日時をその回の時刻にする
  async function addPhotos(hit, inputEl) {
    const files = Array.from(inputEl.files || []);
    inputEl.value = '';
    readHits();
    const room = MAX_PHOTOS - hit.photos.length;
    if (files.length > room) toast(`写真は1回につき${MAX_PHOTOS}枚までです。${room}枚だけ追加します`);
    const hadTime = photoTime(hit);
    busy(true, '写真を準備しています…');
    try {
      for (const file of files.slice(0, room)) {
        const p = await preparePhoto(file);
        created.push(p.previewUrl);
        hit.photos.push({ kind: 'new', ...p });
      }
      dirty = true;
    } catch (err) {
      toast(err.message, 4000);
    } finally {
      busy(false);
      const t = photoTime(hit);
      if (hit.usePhoto && t && +t !== +hadTime) toast('写真の撮影日時を入れました');
      syncDate();
      if (t) estimateLoc(+t);
    }
  }

  // 撮影時刻から、釣行の記録で位置を推定する（優先順：釣れた！ ＞ 推定 ＞ 手動）
  function estimateLoc(t) {
    if (locSource === 'button' || locDecided) return;
    const est = estimatePoint(albumId, st.data.trips, session.member_id, t);
    if (!est) return;
    const p = est.point;
    if (loc && locSource === 'estimated' && loc.lat === p.lat && loc.lng === p.lng) return;
    setLoc({ lat: p.lat, lng: p.lng }, { source: 'estimated' });
    toast(`撮影時刻（${fmtHitTime(new Date(t).toISOString(), new Date(t).toISOString())}）の釣行記録から位置を推定しました`, 3500);
  }

  // ---------- 潮（回ごと） ----------
  // 潮名：その回の日付の月齢から自動で入れる（時刻が変わったら入れ直す。手で選んだらそのまま。
  // 渓流などは、あとから「（未選択）」を選ぶ）。編集では、時刻を変えるまで保存済みの潮を残す。
  // 潮位（予測）：欄はいつも出し、時刻・位置・潮がそろわないときや、データが無いときは「ー」
  function syncTide(h) {
    const card = hitsEl.querySelector(`[data-hit="${h.uid}"]`);
    if (!card) return;
    const hint = card.querySelector('[data-tide-hint]');
    const levelEl = card.querySelector('[data-tide-level]');
    const d = new Date(h.at);
    const n = (h._tideReq = (h._tideReq || 0) + 1);
    const dash = note => { levelEl.textContent = 'ー'; levelEl.title = note || ''; };
    if (!h.at || isNaN(d)) {
      hint.textContent = '';
      return dash();
    }
    const t = tideForDate(d);
    if (!h.tideTouched && h.at !== h.tideAt) {
      h.tide_name = t.name;
      h.tideAt = h.at;
      card.querySelector('[data-f="tide_name"]').value = t.name;
    }
    hint.textContent = `この日の潮は「${t.name}」（月齢${t.age.toFixed(1)}から自動）。潮に関係ない釣りは「（未選択）」に。`;
    if (!h.tide_name || !loc) return dash();
    tideLevel(loc.lat, loc.lng, d).then(r => {
      if (n !== h._tideReq) return; // もっと新しい計算が始まっている
      const el = hitsEl.querySelector(`[data-hit="${h.uid}"] [data-tide-level]`);
      if (!el) return;
      if (!r || r.level == null) {
        el.textContent = 'ー';
        return;
      }
      el.innerHTML = `<b>${esc(tideNowText(r, d.getTime()))}</b>`;
    });
  }

  // ---------- 時刻（「写真から入力」がオンの回は、写真の撮影日時を入れる） ----------
  function syncDate() {
    if (hitsEl.querySelector('[data-f]')) readHits();
    hits.forEach(h => { const t = h.usePhoto && photoTime(h); if (t) h.at = toLocalInput(t); });
    sortHits();
    drawHits();
    moved = [];
  }
  syncDate();

  // ---------- 釣り場（位置） ----------
  let picker = null;
  const locSrcEl = document.getElementById('loc-src');
  function setLoc(value, { fromPicker = false, fromText = false, source } = {}) {
    loc = value ? { lat: Number(value.lat.toFixed(6)), lng: Number(value.lng.toFixed(6)) } : null;
    if (source) locSource = source;
    if (!loc) locSource = '';
    locSrcEl.textContent = loc && locSource ? `位置の出どころ：${{ button: '📍「釣れた！」の記録', estimated: '推定（撮影時刻の釣行記録）', manual: '手動' }[locSource]}` : '';
    if (!fromText) coord.value = loc ? fmtCoord(loc.lat, loc.lng) : '';
    if (loc && picker && !fromPicker) picker.set(loc);
    gmaps.href = loc ? googleMapsUrl(loc.lat, loc.lng) : '#';
    gmaps.classList.toggle('disabled', !loc);
    hits.forEach(syncTide);
  }
  if (mapReady()) {
    picker = createPickerMap(document.getElementById('picker'), {
      layerKey: settings.layer,
      value: loc,
      fallbackCenter: lastCatch ? { lat: lastCatch.lat, lng: lastCatch.lng } : null,
      onChange: ll => { dirty = true; locDecided = true; setLoc(ll, { fromPicker: true, source: 'manual' }); }
    });
  } else {
    document.getElementById('picker').innerHTML = '<p class="muted small">地図を読み込めませんでした。現在地か緯度経度で指定してください。</p>';
  }
  setLoc(loc);
  gmaps.addEventListener('click', e => { if (!loc) { e.preventDefault(); toast('先に位置を指定してください'); } });
  coord.addEventListener('change', () => {
    if (!coord.value.trim()) return setLoc(null, { fromText: true });
    const ll = parseLatLng(coord.value);
    if (!ll) return toast('「35.123, 138.123」の形で入力してください');
    locDecided = true;
    setLoc(ll, { source: 'manual' });
  });
  coord.addEventListener('paste', () => setTimeout(() => coord.dispatchEvent(new Event('change')), 0));
  document.getElementById('locate-btn').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const p = await getCurrentPosition();
      dirty = true;
      locDecided = true;
      setLoc(p, { source: 'manual' });
      toast('現在地を入れました');
    } catch (err) {
      toast(err.message, 4000);
    } finally {
      btn.disabled = false;
    }
  });

  current.cleanup = () => {
    if (picker) picker.remove();
    // 送信待ちで使っている写真のプレビューは残す
    const inUse = new Set(stateOf(albumId).pending.flatMap(p => p._previews || []));
    created.filter(u => !inUse.has(u)).forEach(u => URL.revokeObjectURL(u));
  };

  // 戻るときに入力が消える確認
  const backBtn = $app.querySelector('[data-back]');
  backBtn.addEventListener('click', e => {
    if (dirty && !confirm('入力した内容を破棄して戻りますか？')) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  // ---------- 保存 ----------
  form.addEventListener('submit', async e => {
    e.preventDefault();
    readHits();
    needSort = false;
    const bad = (i, msg) => {
      toast(hits.length > 1 ? `${i + 1}回目：${msg}` : msg);
      const card = hitsEl.querySelector(`[data-hit="${hits[i].uid}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h.at || isNaN(new Date(h.at))) return bad(i, '時刻を入力してください');
      if (!Number.isInteger(Number(h.count)) || Number(h.count) < 1) return bad(i, '匹数は1以上の整数で入力してください');
      if (!String(h.species).trim()) return bad(i, '魚種を入力してください');
    }
    sortHits();
    if (coord.value.trim()) {
      const typed = parseLatLng(coord.value);
      if (!typed) return toast('緯度経度の形が正しくありません（例：35.123, 138.123）');
      if (typed.lat !== loc?.lat || typed.lng !== loc?.lng) setLoc(typed, { source: 'manual' });
    }
    if (!loc) return toast('釣り場の位置を指定してください（地図をタップ・現在地・緯度経度）');

    const num = v => (v === '' || v == null ? '' : Number(v));
    const hitData = hits.map(h => ({
      at: toLocalIso(new Date(h.at)),
      count: Number(h.count),
      species: String(h.species).trim(),
      size_cm: num(h.size_cm),
      weight_g: num(h.weight_g),
      angler_member_id: h.angler_member_id,
      tide_name: h.tide_name,
      method: String(h.method).trim(),
      bait: String(h.bait).trim(),
      memo: String(h.memo).trim()
    }));
    const photos = hits.flatMap(h => h.photos); // 全部の写真（回の順）。送ったあと回ごとに分け直す
    const photoCounts = hits.map(h => h.photos.length);
    const fields = {
      ...summarizeHits(hitData),
      lat: loc.lat,
      lng: loc.lng,
      place_name: form.elements.place_name.value.trim(),
      hits: hitData,
      loc_source: locSource || 'manual',
      draft: false
    };
    // 進行中の釣行の時刻なら、その釣行にひも付ける（終わった釣行へのひも付けは GAS がする）
    const trip = activeTrip(albumId);
    if (trip && Date.parse(fields.caught_at) >= Date.parse(trip.started_at) - 60000) fields.trip_id = trip.trip_id; // 時刻は分までなので1分の余裕
    else if (localDraft) fields.trip_id = localDraft.trip_id;
    else if (orig && orig.trip_id) fields.trip_id = orig.trip_id;

    if (!editing) {
      // 先に一覧に出して、裏で送る
      const p = {
        ...fields,
        catch_id: 'tmp-' + Date.now(),
        size_cm: fields.size_cm === '' ? null : fields.size_cm,
        weight_g: fields.weight_g === '' ? null : fields.weight_g,
        photo_ids: [],
        _pending: 'sending',
        _photos: photos,
        _photoCounts: photoCounts,
        _uploaded: [],
        _previews: photos.filter(x => x.kind === 'new').map(x => x.previewUrl)
      };
      st.pending.push(p);
      if (localDraft) removeDraft(albumId, localDraft.catch_id); // 下書きは、この登録に置きかわる
      if (trip) recordPoint(albumId, 'catch'); // 釣行中なら、登録した時の位置も記録
      dirty = false;
      replaceHash(`#/a/${albumId}/list`);
      sendPending(albumId, p);
      return;
    }

    busy(true, photos.some(p => p.kind === 'new') ? '写真を送っています…' : '保存しています…');
    try {
      const photoIds = await uploadPhotos(session.token, photos, null);
      busy(true, '保存しています…');
      const payload = { token: session.token, catch: { ...fields, catch_id: catchId, hits: withHitPhotos(fields.hits, photoIds, photoCounts), photo_ids: photoIds }, base_updated_at: orig.updated_at };
      let res;
      try {
        res = await api('saveCatch', payload);
      } catch (err) {
        if (err.code !== 'conflict') throw err;
        busy(false);
        if (!confirm('他の人が先にこの釣果を更新しています。あなたの内容で上書きしますか？\n（キャンセルすると保存しません）')) return;
        busy(true, '保存しています…');
        res = await api('saveCatch', { ...payload, force: true });
      }
      const i = st.data.catches.findIndex(c => c.catch_id === catchId);
      if (i >= 0) st.data.catches[i] = res.catch;
      saveStateCache(albumId);
      dirty = false;
      toast('保存しました');
      replaceHash(`#/a/${albumId}/c/${catchId}`);
    } catch (err) {
      toast(err.message, 4000);
    } finally {
      busy(false);
    }
  });
}

// ---------- 詳細 ----------

function viewDetail(albumId, catchId) {
  const st = stateOf(albumId);
  let mini = null;

  function draw() {
    if (mini) { mini.remove(); mini = null; }
    const c = st.data && st.data.catches.find(x => x.catch_id === catchId);
    if (!c) {
      $app.innerHTML = `${topbar('詳細', { back: `#/a/${albumId}/list` })}<main class="page">
        ${st.data ? errorBox('この釣果は見つかりません（削除された可能性があります）', false) : '<div class="skeleton-card"></div>'}</main>`;
      return;
    }
    const hs = hitsOf(c);
    const many = hs.length > 1;
    const trip = c.trip_id ? tripsOf(albumId).find(t => t.trip_id === c.trip_id) : null;
    const fieldsHtml = rows => `<dl class="fields">${rows.filter(r => hasValue(r[1])).map(r => `<dt>${esc(r[0])}</dt><dd>${esc(r[1])}</dd>`).join('')}</dl>`;
    const sizeText = h => [hasValue(h.size_cm) ? `${h.size_cm}cm` : '', hasValue(h.weight_g) ? `${h.weight_g}g` : '', h.count > 1 ? `${h.count}匹` : ''].filter(Boolean).join('・');
    // 回ごとのカード（回が1つなら、これまでどおりの1枚のカード）
    const hitCard = (h, i) => `<section class="card hit-detail">
      <h2>${many ? `<span class="hit-badge">${i + 1}回目</span> ${esc(fmtHitTime(h.at, c.caught_at))}　${esc(h.species)}` : esc(h.species)} <span class="size">${esc(sizeText(h))}</span></h2>
      ${many && h.photos.length ? `<div class="strip">${h.photos.map(p => photoImg(p.f, 800)).join('')}</div>` : ''}
      ${fieldsHtml([
        ...(many ? [] : [['日時', fmtDateTime(h.at)], ['場所名', c.place_name]]),
        ['サイズ', hasValue(h.size_cm) ? `${h.size_cm} cm` : ''],
        ['重さ', hasValue(h.weight_g) ? `${h.weight_g} g` : ''],
        ['匹数', `${h.count} 匹`],
        ['釣った人', memberName(albumId, h.angler_member_id)],
        ['潮', h.tide_name],
        ['釣り方・仕掛け', h.method],
        ['エサ／ルアー', h.bait]
      ]).replace('</dl>', h.tide_name ? `<dt data-tide-hit="${i}" hidden>潮位</dt><dd data-tide-hit="${i}" hidden></dd></dl>` : '</dl>')}
      ${h.memo ? `<p class="memo">${esc(h.memo)}</p>` : ''}
    </section>`;
    const photos = many ? [] : hs[0].photos; // 回が1つなら、写真は上に大きく

    $app.innerHTML = `${topbar(c.species || '下書き', { back: `#/a/${albumId}/list` })}
      <main class="page detail">
        ${photos.length ? `<div class="gallery" id="gallery">${photos.map(p => `<div class="slide">${photoImg(p.f, 1600)}</div>`).join('')}</div>
          ${photos.length > 1 ? `<div class="dots" id="dots">${photos.map((_, i) => `<span class="${i === 0 ? 'on' : ''}"></span>`).join('')}</div>` : ''}` : ''}
        ${c.draft ? `<div class="notice info"><p><b>下書き</b>（「釣れた！」で記録した時刻と位置だけ）です。写真や魚種を入れて保存してください。</p>
          <a class="btn primary block" href="#/a/${esc(albumId)}/c/${esc(c.catch_id)}/edit">続きを入力</a></div>` : ''}
        ${many ? `<section class="card">
          <h2>${esc(c.species)} <span class="size">${esc(catchSummary(c))}</span></h2>
          ${fieldsHtml([
            ['日時', `${fmtDateTime(c.caught_at)}〜${fmtHitTime(hs[hs.length - 1].at, c.caught_at)}`],
            ['場所名', c.place_name],
            ['釣れた回', `${hs.length}回（合計${c.count}匹）`]
          ])}
        </section>` : ''}
        ${hs.map(hitCard).join('')}
        ${hs.some(h => h.tide_name) ? '<section class="card" id="tide-card" hidden></section>' : ''}
        <section class="card">
          <div id="mini-map" class="mini-map"></div>
          <p class="muted small">${esc(fmtCoord(c.lat, c.lng))} ${locSourceChip(c)}</p>
          ${trip ? `<a class="btn block" href="#/a/${esc(albumId)}/map?trip=${esc(trip.trip_id)}">${icon('trip')} 釣行のルートを見る（${esc(tripTitle(albumId, trip))}）</a>` : ''}
          ${spotOfCatch(albumId, c) ? `<a class="btn block" href="#/a/${esc(albumId)}/tide?p=${esc(spotOfCatch(albumId, c).key)}">${icon('tide')} この場所の月間潮表</a>` : ''}
          <a class="btn block" href="${esc(googleMapsUrl(c.lat, c.lng))}" target="_blank" rel="noopener">Googleマップで開く</a>
        </section>
        <p class="muted small meta">登録：${esc(memberName(albumId, c.created_by))}（${esc(fmtDateTime(c.created_at))}）<br>
          更新：${esc(memberName(albumId, c.updated_by))}（${esc(fmtDateTime(c.updated_at))}）</p>
        <div class="row">
          <a class="btn primary grow" href="#/a/${esc(albumId)}/c/${esc(c.catch_id)}/edit">編集</a>
          <button class="btn danger grow" id="delete-btn">削除</button>
        </div>
      </main>`;

    if (mapReady()) mini = createMiniMap(document.getElementById('mini-map'), { layerKey: getSettings().layer, lat: c.lat, lng: c.lng });

    // 潮位（予測）：潮を選んでいる回ごとに、その時刻の潮位。下のカードに潮位グラフ（釣れた時刻に印）
    const tideCard = document.getElementById('tide-card');
    if (tideCard) {
      hs.forEach((h, i) => {
        if (!h.tide_name) return;
        const t = new Date(h.at);
        tideLevel(c.lat, c.lng, t).then(r => {
          const els = document.querySelectorAll(`[data-tide-hit="${i}"]`);
          if (els.length < 2 || !r || r.level == null) return;
          els[1].textContent = tideNowText(r, t.getTime());
          els.forEach(el => { el.hidden = false; });
        });
      });
      const range = tideChartRange(hs, trip);
      if (range) tideSeries(c.lat, c.lng, range.from, range.to).then(series => {
        if (!series || !tideCard.isConnected) return;
        const marks = hs.map(h => ({ t: Date.parse(h.at), h: series.levelAt(Date.parse(h.at)) })).filter(m => m.h != null);
        tideCard.innerHTML = tideChartCardHtml(series, marks, range);
        tideCard.hidden = false;
        bindTideChart(tideCard.querySelector('.tg-wrap'), series, marks, range);
      });
    }

    const gallery = document.getElementById('gallery');
    const dots = document.getElementById('dots');
    if (gallery && dots) {
      gallery.addEventListener('scroll', () => {
        const i = Math.round(gallery.scrollLeft / gallery.clientWidth);
        dots.querySelectorAll('span').forEach((d, j) => d.classList.toggle('on', i === j));
      }, { passive: true });
    }

    document.getElementById('delete-btn').addEventListener('click', async () => {
      if (!confirm(`「${c.species || '下書き'}」の釣果を削除しますか？`)) return;
      const session = sessionFor(albumId);
      busy(true, '削除しています…');
      try {
        const payload = { token: session.token, catch_id: c.catch_id, base_updated_at: c.updated_at };
        try {
          await api('deleteCatch', payload);
        } catch (err) {
          if (err.code !== 'conflict') throw err;
          busy(false);
          if (!confirm('他の人がこの釣果を更新しています。それでも削除しますか？')) return;
          busy(true, '削除しています…');
          await api('deleteCatch', { ...payload, force: true });
        }
        st.data.catches = st.data.catches.filter(x => x.catch_id !== c.catch_id);
        saveStateCache(albumId);
        toast('削除しました');
        replaceHash(`#/a/${albumId}/list`);
      } catch (err) {
        toast(err.message, 4000);
      } finally {
        busy(false);
      }
    });
  }

  current.refresh = draw;
  current.cleanup = () => { if (mini) mini.remove(); };
  draw();
  refreshAlbum(albumId);
}

// ---------- 釣行 ----------

// 終了した釣行（送信待ち）を送る。送れたらアルバムを読み直す
async function sendTrips(albumId, { quiet = false } = {}) {
  const session = sessionFor(albumId);
  if (!session || !outbox(albumId).length) return { sent: 0, error: null };
  const res = await flushOutbox(albumId, trip => api('saveTrip', {
    token: session.token,
    trip: { trip_id: trip.trip_id, started_at: trip.started_at, ended_at: trip.ended_at, points: trip.points, auto_ended: !!trip.auto_ended },
    drafts: trip.drafts
  }));
  if (res.sent) {
    if (!quiet) toast('釣行の記録を送りました');
    refreshAlbum(albumId);
  }
  if (res.error && !quiet) toast(`釣行の記録を送れませんでした（${res.error.message}）。電波のある所で「釣行」を開くと送り直します`, 5000);
  notify(albumId);
  return res;
}

// ---------- 月間潮表 ----------
// 釣ったポイント（釣果の位置を 150m 以内でまとめたもの）ごとに、1か月の潮位を日ごとに並べ、
// そのポイントで釣れたときと「流れ（上げ／下げ○分）」「潮位」が似ている時間に印を付ける。

const SPOT_M = 150;          // 同じポイントとみなす半径
const LIKE_STAGE = 1;        // 流れの差（○分）がこれ以内なら似ている
const LIKE_LEVEL = 15;       // 潮位の差（cm）がこれ以内なら似ている
const LIKE_SWING = 0.2;      // 潮の上下幅（その回の干潮〜満潮の差）の違いがこの割合以内なら似ている
const SAMPLE_MS = 10 * 60000;

// 潮を選んだ釣果があるポイントの一覧（古い釣果から順にまとめるので、キーは変わりにくい）
function spotsOf(albumId) {
  const list = catchesOf(albumId)
    .filter(c => c.species && isFinite(c.lat) && isFinite(c.lng) && hitsOf(c).some(h => h.tide_name))
    .sort((a, b) => (a.caught_at < b.caught_at ? -1 : 1));
  const spots = [];
  for (const c of list) {
    let spot = spots.find(sp => distanceM(sp, c) <= SPOT_M);
    if (!spot) spots.push(spot = { key: c.catch_id, lat: Number(c.lat), lng: Number(c.lng), catches: [] });
    spot.catches.push(c);
  }
  for (const sp of spots) {
    const names = sp.catches.map(c => c.place_name).filter(Boolean);
    const top = names.sort((a, b) => names.filter(n => n === b).length - names.filter(n => n === a).length)[0];
    const d = new Date(sp.catches[0].caught_at);
    sp.name = top || `場所名なし（${d.getMonth() + 1}/${d.getDate()}〜）`;
  }
  return spots.sort((a, b) => b.catches.length - a.catches.length);
}

function spotOfCatch(albumId, c) {
  return spotsOf(albumId).find(sp => sp.catches.some(x => x.catch_id === c.catch_id)) || null;
}

// 釣れた回ごとの「そのときの潮」：潮名・流れ・潮位
// 釣果ごと・回ごと。潮位は見ている場所（lat, lng）のその時刻の値で比べる（ほかの場所の釣果を選んだときも同じ）
// key＝「釣果ID#回の番号」
async function hitPatterns(catches, lat, lng) {
  const hits = catches.flatMap(c => hitsOf(c).map((h, i) => ({ ...h, c, key: `${c.catch_id}#${i}` }))
    .filter(h => h.tide_name && isFinite(Date.parse(h.at))));
  const res = await Promise.all(hits.map(async h => {
    const t = Date.parse(h.at);
    const r = await tideLevel(lat, lng, new Date(t));
    if (!r || r.level == null || !r.prev || !r.next) return null;
    const st = tideStageAt([r.prev, r.next], t);
    return { key: h.key, catchId: h.c.catch_id, t, name: h.tide_name, level: r.level, dir: st.dir, s: st.s, swing: Math.abs(r.next.h - r.prev.h), label: stageLabel(st), species: h.species };
  }));
  return res.filter(Boolean).sort((a, b) => a.t - b.t);
}

// その時刻が、どの回にどれだけ似ているか：流れ・潮位・潮の上下幅が近ければ似ている。
// 2＝潮名も同じ（◎）、1＝潮名は違う（○）、0＝似ていない
function likeness(patterns, name, level, st) {
  let best = { grade: 0, p: null };
  const swing = Math.abs(st.next.h - st.prev.h);
  for (const p of patterns) {
    if (p.dir !== st.dir || Math.abs(p.s - st.s) > LIKE_STAGE || Math.abs(p.level - level) > LIKE_LEVEL) continue;
    if (Math.abs(swing - p.swing) > Math.max(10, p.swing * LIKE_SWING)) continue;
    const grade = p.name === name ? 2 : 1;
    if (grade > best.grade) best = { grade, p };
  }
  return best;
}

// 1日分：10分ごとに潮位と流れを出し、似ている時間をひとまとまりの「時間帯」にする
function tideDayRows(month, patterns, year, mon) {
  const days = [];
  const count = new Date(year, mon, 0).getDate();
  for (let d = 1; d <= count; d++) {
    const start = month.from + (d - 1) * 86400000;
    const name = tideForDate(new Date(year, mon - 1, d)).name;
    const samples = [];
    for (let t = start; t <= start + 86400000; t += SAMPLE_MS) {
      const h = month.levelAt(t);
      const st = tideStageAt(month.events, t);
      samples.push({ t, h, st, like: h == null || !st ? { grade: 0 } : likeness(patterns, name, h, st) });
    }
    const windows = [];
    for (const smp of samples.slice(0, -1)) {
      const last = windows[windows.length - 1];
      if (!smp.like.grade) continue;
      if (last && last.to === smp.t - SAMPLE_MS) {
        last.to = smp.t;
        if (smp.like.grade > last.grade) Object.assign(last, { grade: smp.like.grade, p: smp.like.p });
      } else windows.push({ from: smp.t, to: smp.t, grade: smp.like.grade, p: smp.like.p });
    }
    const events = month.events.filter(e => e.ms >= start && e.ms < start + 86400000);
    days.push({ d, start, name, samples, windows, events, grade: Math.max(0, ...windows.map(w => w.grade)) });
  }
  return days;
}

// 1日の小さなグラフ（0〜24時）。縦軸は月の中で同じ目盛り。似ている時間帯は帯（◎濃い・○薄い）
const MINI = { W: 320, H: 70, L: 4, R: 4, T: 6, B: 16 };
function tideMiniSvg(day, lo, hi) {
  const { W, H, L, R, T, B } = MINI;
  const x = t => L + (t - day.start) / 86400000 * (W - L - R);
  const y = h => T + (hi - h) / (hi - lo) * (H - T - B);
  const f = n => n.toFixed(1);
  const pts = day.samples.filter(p => p.h != null);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${f(x(p.t))},${f(y(p.h))}`).join('');
  const base = H - B;
  return `<svg class="tm-svg" viewBox="0 0 ${W} ${H}" data-day="${day.d}" data-w="${W}" data-l="${L}" data-r="${R}" data-top="${T}" data-bottom="${H - B}" role="img" aria-label="${day.d}日の潮位">
    <g class="tm-grid">${[6, 12, 18].map(hr => `<line x1="${f(x(day.start + hr * 3600000))}" x2="${f(x(day.start + hr * 3600000))}" y1="${T}" y2="${base}"/>`).join('')}</g>
    <line class="tm-base" x1="${L}" x2="${W - R}" y1="${base}" y2="${base}"/>
    ${day.windows.map(w => `<rect class="tm-band g${w.grade}" x="${f(x(w.from))}" y="${T}" width="${f(Math.max(3, x(w.to + SAMPLE_MS) - x(w.from)))}" height="${base - T}" rx="2"/>`).join('')}
    <path class="tm-line" d="${line}"/>
    <g class="tm-xl">${[6, 12, 18].map(hr => `<text x="${f(x(day.start + hr * 3600000))}" y="${H - 3}">${hr}時</text>`).join('')}</g>
    <g class="tm-cross" hidden><line y1="${T}" y2="${base}"/><circle r="3.5"/></g>
  </svg>`;
}

// 1日の大きな潮位グラフ（カレンダーで選んだ日）。夜の海のような濃い背景に、
// 上から「月が出ている時間」「太陽が出ている時間」の帯、潮位の線、満潮・干潮の吹き出し（時刻と潮位）、
// 似ている時間の帯、今の時刻の線。縦軸は月で共通
const BIG = { W: 340, H: 300, L: 34, R: 8, T: 46, B: 22, PAD: 34 };
function tideDaySvg(day, lo, hi, astro) {
  const { W, H, L, R, T, B, PAD } = BIG;
  const base = H - B;
  const top = T + PAD;          // 月の最高潮位の高さ（上に吹き出しの場所を空ける）
  const bottom = base - PAD;    // 月の最低潮位の高さ（下に吹き出しの場所を空ける）
  const end = day.start + 86400000;
  const x = t => L + (Math.min(Math.max(t, day.start), end) - day.start) / 86400000 * (W - L - R);
  const y = h => top + (hi - h) / (hi - lo) * (bottom - top);
  const hAt = py => hi - (py - top) / (bottom - top) * (hi - lo);
  const f = n => n.toFixed(1);
  const span = hAt(T) - hAt(base);
  const step = span > 320 ? 100 : span > 160 ? 50 : span > 80 ? 20 : 10;
  const ticks = [];
  for (let v = Math.ceil(hAt(base) / step) * step; v <= hAt(T); v += step) ticks.push(v);
  // 潮位表の毎時の値と満潮・干潮を、なめらかな曲線（Catmull-Rom）でつなぐ（満干潮の近く20分以内の毎時の値は使わない）
  const near = t => day.events.some(e => Math.abs(e.ms - t) < 20 * 60000);
  const knots = [...day.samples.filter((p, i) => p.h != null && i % 6 === 0 && !near(p.t)), ...day.events.map(e => ({ t: e.ms, h: e.h }))]
    .sort((a, b) => a.t - b.t)
    .map(p => [x(p.t), y(p.h)]);
  const line = knots.map((p, i) => {
    if (!i) return `M${f(p[0])},${f(p[1])}`;
    const p0 = knots[i - 2] || knots[i - 1];
    const p1 = knots[i - 1];
    const p3 = knots[i + 1] || p;
    const c1 = [p1[0] + (p[0] - p0[0]) / 6, p1[1] + (p[1] - p0[1]) / 6];
    const c2 = [p[0] - (p3[0] - p1[0]) / 6, p[1] - (p3[1] - p1[1]) / 6];
    return `C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p[0])},${f(p[1])}`;
  }).join('');
  const hours = [0, 3, 6, 9, 12, 15, 18, 21, 24];

  // 月・太陽の帯（出ている区間）と、出・入りの時刻
  const bar = (body, cls, row, label) => {
    const by = row === 0 ? 6 : 24;
    const times = [...body.rise.map(t => ({ t, anchor: 'start' })), ...body.set.map(t => ({ t, anchor: 'end' }))];
    return `<text class="td-bar-label" x="${L - 5}" y="${by + 10}">${label}</text>
      <rect class="td-track" x="${L}" y="${by}" width="${W - L - R}" height="14" rx="3"/>
      ${body.spans.map(sp => `<rect class="${cls}" x="${f(x(sp.from))}" y="${by}" width="${f(Math.max(2, x(sp.to) - x(sp.from)))}" height="14" rx="3"/>`).join('')}
      ${times.map(m => {
        const tx = m.anchor === 'start' ? Math.min(x(m.t) + 3, W - R - 30) : Math.max(x(m.t) - 3, L + 30);
        return `<text class="td-bar-time" x="${f(tx)}" y="${by + 10.5}" text-anchor="${m.anchor}">${jstTime(m.t)}</text>`;
      }).join('')}`;
  };
  // 夜（太陽が出ていない時間）は少し暗く
  const nights = [];
  let from = day.start;
  for (const sp of astro.sun.spans) {
    if (sp.from > from) nights.push({ from, to: sp.from });
    from = sp.to;
  }
  if (from < end) nights.push({ from, to: end });

  // 満潮・干潮の吹き出し：満潮は山の上、干潮は谷の下
  const callouts = day.events.map(e => {
    const cx = Math.min(Math.max(x(e.ms), L + 26), W - R - 26);
    const cy = y(e.h);
    const up = e.type === '満潮';
    const by = up ? cy - 9 - 28 : cy + 9;
    const tip = up ? `M${f(x(e.ms) - 4)},${f(cy - 9)}L${f(x(e.ms))},${f(cy - 4)}L${f(x(e.ms) + 4)},${f(cy - 9)}Z`
      : `M${f(x(e.ms) - 4)},${f(cy + 9)}L${f(x(e.ms))},${f(cy + 4)}L${f(x(e.ms) + 4)},${f(cy + 9)}Z`;
    return `<g class="td-call ${up ? 'high' : 'low'}"><rect x="${f(cx - 25)}" y="${f(by)}" width="50" height="28" rx="6"/><path d="${tip}"/>
      <text x="${f(cx)}" y="${f(by + 12)}" class="td-call-time">${jstTime(e.ms)}</text>
      <text x="${f(cx)}" y="${f(by + 24)}">${Math.round(e.h)}cm</text></g>`;
  }).join('');

  const now = Date.now();
  const nowH = now >= day.start && now < end ? day.samples.find(p => Math.abs(p.t - now) <= SAMPLE_MS / 2) : null;
  return `<svg class="tm-svg td-svg" viewBox="0 0 ${W} ${H}" data-day="${day.d}" data-w="${W}" data-l="${L}" data-r="${R}" data-top="${top}" data-bottom="${bottom}" role="img" aria-label="${day.d}日の潮位">
    ${bar(astro.moon, 'td-moon', 0, '月')}
    ${bar(astro.sun, 'td-sun', 1, '日')}
    ${nights.map(n => `<rect class="td-night" x="${f(x(n.from))}" y="${T}" width="${f(x(n.to) - x(n.from))}" height="${base - T}"/>`).join('')}
    <g class="td-grid">
      ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${f(y(v))}" y2="${f(y(v))}"/>`).join('')}
      ${hours.map(hr => `<line x1="${f(x(day.start + hr * 3600000))}" x2="${f(x(day.start + hr * 3600000))}" y1="${T}" y2="${base}"/>`).join('')}
    </g>
    <g class="td-yl">${ticks.map(v => `<text x="${L - 5}" y="${f(y(v) + 3.5)}">${v}</text>`).join('')}</g>
    ${day.windows.map(w => {
      const wx = f(x(w.from));
      const ww = f(Math.max(3, x(w.to + SAMPLE_MS) - x(w.from)));
      return `<rect class="td-band g${w.grade}" x="${wx}" y="${T}" width="${ww}" height="${base - T}"/><rect class="td-band-cap g${w.grade}" x="${wx}" y="${T}" width="${ww}" height="4"/>`;
    }).join('')}
    <path class="td-line" d="${line}"/>
    ${nowH && nowH.h != null ? `<line class="td-now" x1="${f(x(now))}" x2="${f(x(now))}" y1="${T}" y2="${base}"/><circle class="td-now-dot" cx="${f(x(now))}" cy="${f(y(nowH.h))}" r="4.5"/>` : ''}
    ${callouts}
    <g class="td-xl">${hours.map(hr => `<text x="${f(x(day.start + hr * 3600000))}" y="${H - 6}">${hr}</text>`).join('')}</g>
    <text class="td-unit" x="${L - 5}" y="${H - 6}">時</text>
    <g class="tm-cross" hidden><line y1="${T}" y2="${base}"/><circle r="4"/></g>
  </svg>`;
}

function viewTideMonth(albumId, params) {
  const st = stateOf(albumId);
  const now = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(params.get('m') || '');
  const year = m ? Number(m[1]) : now.getFullYear();
  const mon = m ? Number(m[2]) : now.getMonth() + 1;
  const filters = { name: false, flow: false }; // 絞り込み（オンにした条件をすべて満たす日だけ）
  let showPast = false;                      // 今日より前の日は、ボタンを押すまで隠す
  let view = 'cal'; // 最初はカレンダー
  let selected = Number(params.get('d')) || null; // カレンダーで選んだ日
  let req = 0;
  let result = null; // { spotKey, month, days, lo, hi, all（選べる回）, chosen（選んだ回の key） }
  let showOthers = false; // ほかの場所の釣果も選べるように開く

  const monthHref = (key, dy) => {
    const dt = new Date(year, mon - 1 + dy, 1);
    return `#/a/${esc(albumId)}/tide?p=${esc(key)}&m=${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
  };

  function draw() {
    const spots = spotsOf(albumId);
    const spot = spots.find(sp => sp.key === params.get('p')) || spots[0];
    let html = '';
    if (st.error && st.error.code === 'invalid_token') html += invalidTokenBox(albumId);
    if (!spot) {
      html += st.data || !st.loading
        ? `<div class="empty"><p>潮を選んだ釣果を登録すると、その釣り場（ポイント）の月間潮表がここに出ます。</p><a class="btn primary" href="#/a/${esc(albumId)}/new">釣果を登録する</a></div>`
        : '<div class="skeleton-card"></div>';
    } else {
      html += `<section class="card form tm-head">
          <label>ポイント
            <select id="spot-select">${spots.map(sp => `<option value="${esc(sp.key)}" ${sp === spot ? 'selected' : ''}>${esc(sp.name)}（釣果${sp.catches.length}件）</option>`).join('')}</select>
          </label>
          <div id="tm-patterns"><p class="muted small">このポイントで釣れたときの潮を調べています…</p></div>
        </section>
        <div class="tm-month">
          <a class="icon-btn" href="${monthHref(spot.key, -1)}" aria-label="前の月">${icon('back')}</a>
          <b>${year}年${mon}月</b>
          <a class="icon-btn flip" href="${monthHref(spot.key, 1)}" aria-label="次の月">${icon('back')}</a>
        </div>
        <div class="tm-view seg" role="group" aria-label="表示の形">
          <button type="button" data-view="list" aria-pressed="${view === 'list'}">リスト</button>
          <button type="button" data-view="cal" aria-pressed="${view === 'cal'}">カレンダー</button>
        </div>
        <div class="tm-filters" role="group" aria-label="絞り込み">
          <button type="button" class="fchip" data-filter="name" aria-pressed="${filters.name}">${icon('moon')}潮名が同じ</button>
          <button type="button" class="fchip" data-filter="flow" aria-pressed="${filters.flow}">${icon('tide')}流れが似ている</button>
        </div>
        <div id="tm-days"><div class="skeleton-card"></div></div>`;
    }
    $app.innerHTML = `${albumTopbar(albumId)}<main class="page with-tabbar">${html}</main>${tabbar(albumId, 'tide')}`;
    if (!spot) return;

    document.getElementById('spot-select').addEventListener('change', e => { location.hash = monthHref(e.target.value, 0).replace(/&amp;/g, '&'); });
    document.getElementById('tm-patterns').addEventListener('change', e => {
      const box = e.target;
      if (!result || !(box.dataset.catch || box.dataset.hit)) return;
      const keys = box.dataset.catch ? result.all.filter(p => p.catchId === box.dataset.catch).map(p => p.key) : [box.dataset.hit];
      keys.forEach(k => (box.checked ? result.chosen.add(k) : result.chosen.delete(k)));
      recalc();
      drawPatterns();
      drawDays();
    });
    $app.querySelectorAll('[data-filter]').forEach(el => el.addEventListener('click', () => {
      filters[el.dataset.filter] = !filters[el.dataset.filter];
      el.setAttribute('aria-pressed', String(filters[el.dataset.filter]));
      drawDays();
    }));
    $app.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => {
      view = el.dataset.view;
      $app.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === el)));
      drawDays();
    }));
    if (result && result.spotKey === spot.key && result.sig === signature(spots)) {
      drawPatterns();
      drawDays();
    } else compute(spot, spots);
  }

  // ポイントの釣果が変わったら計算し直す
  const signature = spots => spots.flatMap(sp => sp.catches).map(c => c.catch_id + c.updated_at).join();

  async function compute(spot, spots) {
    const n = ++req;
    // 選べる釣果：この場所の釣果（新しい順）→ ほかの場所の釣果（新しい順）
    const here = [...spot.catches].sort((a, b) => (a.caught_at < b.caught_at ? 1 : -1));
    const others = spots.filter(sp => sp !== spot).flatMap(sp => sp.catches).sort((a, b) => (a.caught_at < b.caught_at ? 1 : -1));
    const [all, month] = await Promise.all([hitPatterns([...here, ...others], spot.lat, spot.lng), tideMonth(spot.lat, spot.lng, year, mon)]);
    if (n !== req) return;
    const prev = result && result.spotKey === spot.key ? result.chosen : null;
    const hereIds = new Set(here.map(c => c.catch_id));
    result = {
      spotKey: spot.key, sig: signature(spots), lat: spot.lat, lng: spot.lng, month, days: null,
      here, others, all,
      // 最初はこの場所の釣果の回をすべて選ぶ（釣果が更新されたときは、前の選び方を残す）
      chosen: prev ? new Set([...prev].filter(k => all.some(p => p.key === k))) : new Set(all.filter(p => hereIds.has(p.catchId)).map(p => p.key))
    };
    if (month) {
      const hs = [];
      for (let t = month.from; t <= month.to; t += SAMPLE_MS) {
        const h = month.levelAt(t);
        if (h != null) hs.push(h);
      }
      result.lo = Math.floor(Math.min(...hs) / 10) * 10;
      result.hi = Math.ceil(Math.max(...hs) / 10) * 10;
    }
    if (result.all.some(p => !hereIds.has(p.catchId) && result.chosen.has(p.key))) showOthers = true;
    recalc();
    drawPatterns();
    drawDays();
  }

  // 選んだ回で、似ている時間を計算し直す
  function recalc() {
    const patterns = result.all.filter(p => result.chosen.has(p.key));
    result.patterns = patterns;
    result.days = result.month ? tideDayRows(result.month, patterns, year, mon) : null;
  }

  // 参考にする釣果：釣果ごとにチェック、回が2つ以上ならその下に回ごとのチェック
  function catchRows(list) {
    return list.map(c => {
      const ps = result.all.filter(p => p.catchId === c.catch_id);
      if (!ps.length) return '';
      const on = ps.filter(p => result.chosen.has(p.key)).length;
      const d = new Date(c.caught_at);
      const date = `${d.getFullYear() !== year ? `${d.getFullYear()}/` : ''}${d.getMonth() + 1}/${d.getDate()}`;
      const patText = p => `<b>${esc(p.name)}・${esc(p.label)}・${p.level}cm</b>`;
      return `<div class="tm-catch${on ? ' on' : ''}">
        <label class="tm-check"><input type="checkbox" data-catch="${esc(c.catch_id)}" ${on === ps.length ? 'checked' : ''} ${on && on < ps.length ? 'data-mixed' : ''}>
          <span><span class="tm-catch-title">${date}　${esc(c.species || '')}</span>${c.place_name ? `<span class="muted small">　${esc(c.place_name)}</span>` : ''}
          ${ps.length === 1 ? `<br><span class="small">${jstTime(ps[0].t)}　${patText(ps[0])}</span>` : ''}</span></label>
        ${ps.length > 1 ? `<div class="tm-hits">${ps.map((p, i) => `<label class="tm-check small"><input type="checkbox" data-hit="${esc(p.key)}" ${result.chosen.has(p.key) ? 'checked' : ''}>
          <span>${i + 1}回目 ${jstTime(p.t)}　${patText(p)}　<span class="muted">${esc(p.species || '')}</span></span></label>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
  }

  function drawPatterns() {
    const el = document.getElementById('tm-patterns');
    if (!el || !result) return;
    const hereRows = catchRows(result.here);
    const otherCount = result.others.filter(c => result.all.some(p => p.catchId === c.catch_id)).length;
    el.innerHTML = result.all.length
      ? `<p class="field-label">参考にする釣果 <span class="muted small">（${result.chosen.size}回を選択中）</span></p>
        <div class="tm-catches">${hereRows || '<p class="muted small">この場所の釣果の時刻では、潮位のデータが見つかりませんでした。</p>'}</div>
        ${otherCount ? (showOthers
          ? `<p class="field-label tm-others-label">ほかの場所の釣果</p><div class="tm-catches">${catchRows(result.others)}</div>`
          : `<button type="button" class="btn small block" id="show-others">ほかの場所の釣果も選ぶ（${otherCount}件）</button>`) : ''}
        ${result.chosen.size ? '' : '<p class="muted small">釣果を1つ以上選ぶと、似ている日時に印が付きます。</p>'}`
      : '<p class="muted small">潮を選んだ釣果の時刻では、潮位のデータが見つかりませんでした。</p>';
    el.querySelectorAll('[data-mixed]').forEach(i => { i.indeterminate = true; });
    const more = document.getElementById('show-others');
    if (more) more.addEventListener('click', () => { showOthers = true; drawPatterns(); });
  }

  const isPast = day => day.start + 86400000 <= Date.now();
  // 絞り込みは重ねがけ：潮名が同じ → 流れが似ている、の両方なら「潮名が同じ回と、流れも似ている時間がある日」（◎）
  const filtering = () => filters.name || filters.flow;
  const matches = day => {
    if (filters.name && filters.flow) return day.has2;
    if (filters.name) return day.sameName;
    if (filters.flow) return day.has1 || day.has2;
    return true;
  };
  const WD = '日月火水木金土';

  function dayCardHtml(day) {
    const dt = new Date(year, mon - 1, day.d);
    return `<section class="card tm-day${day.grade ? ' like' : ''}" data-card="${day.d}">
      <div class="tm-day-head">
        <b class="${dt.getDay() === 0 ? 'sun' : dt.getDay() === 6 ? 'sat' : ''}">${mon}/${day.d}（${WD[dt.getDay()]}）</b>
        <span class="chip">${esc(day.name)}</span>
        ${day.has2 ? '<span class="like-badge g2">◎</span>' : ''}${day.has1 ? '<span class="like-badge g1">○</span>' : ''}
        <span class="tm-ev muted small">${day.events.map(e => `${e.type === '満潮' ? '満' : '干'} ${jstTime(e.ms)}`).join('　')}</span>
      </div>
      ${tideMiniSvg(day, result.lo, result.hi)}
      <p class="tm-tip muted small">${day.windows.map(w => `${w.grade === 2 ? '◎' : '○'} ${jstTime(w.from)}〜${jstTime(w.to + SAMPLE_MS)}（${new Date(w.p.t).getMonth() + 1}/${new Date(w.p.t).getDate()}の${esc(w.p.label)}・${w.p.level}cm に似ている）`).join('<br>')}</p>
    </section>`;
  }

  // カレンダーで選んだ日：大きなグラフ。前後の日へ移れる（月をまたぐときは、その月の表を開く）
  function dayBigHtml(day, days) {
    const dt = new Date(year, mon - 1, day.d);
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const navBtn = dir => {
      const target = new Date(year, mon - 1, day.d + dir);
      const label = dir < 0 ? `‹ ${target.getDate()}日` : `${target.getDate()}日 ›`;
      if (target.getTime() < todayStart && !showPast) return `<span class="td-nav off">${label}</span>`;
      if (target.getMonth() !== mon - 1) return `<a class="td-nav" href="${monthHref(result.spotKey, dir)}&d=${target.getDate()}">${label}</a>`;
      return `<button type="button" class="td-nav" data-daynav="${target.getDate()}">${label}</button>`;
    };
    const astro = sunMoonDay(result.lat, result.lng, day.start, day.start + 86400000);
    const now = Date.now();
    let nowText = '';
    if (now >= day.start && now < day.start + 86400000) {
      const h = result.month.levelAt(now);
      const st = tideStageAt(result.month.events, now);
      if (h != null && st) nowText = `<span class="td-now-text">現在 <b>${Math.round(h)}cm</b>・${st.dir}${st.s.toFixed(1)}分</span>`;
    }
    return `<section class="td-card" data-card="${day.d}">
      <div class="td-head">
        ${navBtn(-1)}
        <div class="td-title"><b>${mon}月${day.d}日（${WD[dt.getDay()]}）</b><span class="td-tide">${esc(day.name)}</span></div>
        ${navBtn(1)}
      </div>
      <div class="td-sub">
        <span>月齢 ${tideForDate(dt).age.toFixed(1)}</span>${nowText}
        ${day.has2 ? '<span class="like-badge g2">◎</span>' : ''}${day.has1 ? '<span class="like-badge g1">○</span>' : ''}
      </div>
      ${tideDaySvg(day, result.lo, result.hi, astro)}
      <p class="tm-tip">${day.windows.map(w => `${w.grade === 2 ? '◎' : '○'} ${jstTime(w.from)}〜${jstTime(w.to + SAMPLE_MS)}（${new Date(w.p.t).getMonth() + 1}/${new Date(w.p.t).getDate()}の${esc(w.p.label)}・${w.p.level}cm に似ている）`).join('<br>')}</p>
    </section>`;
  }

  // カレンダー：1マス＝1日（潮名の頭文字と◎○）。押すと下にその日のグラフ
  function calendarHtml(days) {
    const offset = new Date(year, mon - 1, 1).getDay();
    const cells = [...Array(offset).fill(null), ...days];
    return `<div class="tm-cal">
      ${[...WD].map((w, i) => `<span class="tm-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}
      ${cells.map(day => {
        if (!day) return '<span></span>';
        const hidden = isPast(day) && !showPast;
        const on = !hidden && matches(day);
        const mark = !on ? '' : day.has2 ? '◎' : day.has1 && !(filters.name && filters.flow) ? '○' : '';
        const cls = ['tm-cell', hidden ? 'past' : '', !on && !hidden ? 'dim' : '', mark === '◎' ? 'g2' : mark === '○' ? 'g1' : '', selected === day.d ? 'sel' : ''].filter(Boolean).join(' ');
        return `<button type="button" class="${cls}" data-cal="${day.d}" ${hidden ? 'disabled' : ''} aria-label="${mon}/${day.d} ${esc(day.name)}${mark ? ' ' + mark : ''}">
          <b>${day.d}</b><small>${hidden ? '' : esc(day.name.slice(0, 1))}</small><i>${mark}</i></button>`;
      }).join('')}
    </div>`;
  }

  function drawDays() {
    const el = document.getElementById('tm-days');
    if (!el || !result) return;
    const { month, days } = result;
    if (!month) {
      el.innerHTML = '<p class="muted small tm-empty">この月の潮位データはありません（前年〜来年の分まで見られます）。</p>';
      return;
    }
    const names = new Set(result.patterns.map(p => p.name));
    for (const d of days) {
      d.sameName = names.has(d.name);
      d.has2 = d.windows.some(w => w.grade === 2);
      d.has1 = d.windows.some(w => w.grade === 1);
    }
    const past = days.filter(isPast);
    const visible = days.filter(d => showPast || !isPast(d));
    const pastBtn = past.length
      ? `<button type="button" class="btn small block tm-past" id="toggle-past">${showPast ? '過去の日を隠す' : `過去の日を表示する（${past.length}日）`}</button>`
      : '';
    const hit = visible.filter(d => d.grade && matches(d));
    const count = `<p class="muted small tm-count">${past.length && !showPast ? '今日から' : 'この月'}　<b>◎</b> ${hit.filter(d => d.has2).length}日　<b>○</b> ${hit.filter(d => !d.has2).length}日${filtering() ? `　（絞り込み中：${visible.filter(matches).length}日）` : ''}</p>`;
    const source = `<p class="muted small tm-source">${esc(month.station.name)}（約${Math.round(month.km)}km）の予測です。出典：気象庁「潮位表」。川の上流などでは時刻が遅れることがあります。</p>`;

    if (view === 'cal') {
      const inMonth = d => days.find(x => x.d === d && (showPast || !isPast(x)) && matches(x)); // 絞り込み中は当てはまる日を選ぶ
      if (!inMonth(selected)) {
        const today = new Date();
        const t = today.getFullYear() === year && today.getMonth() + 1 === mon ? today.getDate() : null;
        selected = (inMonth(t) || visible.find(d => d.grade && matches(d)) || visible[0] || {}).d || null;
      }
      const day = days.find(d => d.d === selected);
      el.innerHTML = `${count}${pastBtn}${calendarHtml(days)}${day ? dayBigHtml(day, days) : ''}${source}`;
    } else {
      const shown = visible.filter(matches);
      el.innerHTML = `${count}${pastBtn}
        ${shown.length ? shown.map(dayCardHtml).join('') : `<p class="muted small tm-empty">${filtering() ? '選んだ印のある日はありません。' : visible.length ? '' : 'この月の日はすべて過ぎています。'}</p>`}
        ${source}`;
    }
    const btn = document.getElementById('toggle-past');
    if (btn) btn.addEventListener('click', () => { showPast = !showPast; drawDays(); });
    el.querySelectorAll('[data-daynav]').forEach(b => b.addEventListener('click', () => {
      selected = Number(b.dataset.daynav);
      drawDays();
    }));
    el.querySelectorAll('[data-cal]').forEach(b => b.addEventListener('click', () => {
      selected = Number(b.dataset.cal);
      drawDays();
      const card = el.querySelector('[data-card]');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }));
  }

  // グラフをなぞると、その時刻の潮位と流れを出す
  function onPoint(e) {
    const svg = e.target.closest && e.target.closest('.tm-svg');
    if (!svg || !result || !result.days) return;
    const day = result.days.find(d => String(d.d) === svg.dataset.day);
    const box = svg.getBoundingClientRect();
    const g = svg.dataset;
    const [W, L, R, top, bottom] = [g.w, g.l, g.r, g.top, g.bottom].map(Number);
    const vx = Math.min(W - R, Math.max(L, (e.clientX - box.left) / box.width * W));
    const t = day.start + Math.round((vx - L) / (W - L - R) * 86400000 / SAMPLE_MS) * SAMPLE_MS;
    const smp = day.samples.find(p => p.t === t);
    if (!smp || smp.h == null) return;
    const x = L + (t - day.start) / 86400000 * (W - L - R);
    const y = top + (result.hi - smp.h) / (result.hi - result.lo) * (bottom - top);
    const cross = svg.querySelector('.tm-cross');
    cross.hidden = false;
    cross.querySelector('line').setAttribute('x1', x);
    cross.querySelector('line').setAttribute('x2', x);
    cross.querySelector('circle').setAttribute('cx', x);
    cross.querySelector('circle').setAttribute('cy', y);
    const tip = svg.parentElement.querySelector('.tm-tip');
    if (!tip.dataset.orig) tip.dataset.orig = tip.innerHTML || ' ';
    tip.innerHTML = `<b>${jstTime(t)}　${Math.round(smp.h)}cm・${esc(stageLabel(smp.st))}</b>${smp.like.grade ? `（${smp.like.grade === 2 ? '◎' : '○'}）` : ''}`;
  }
  function onLeave(e) {
    const svg = e.target.closest && e.target.closest('.tm-svg');
    if (!svg) return;
    svg.querySelector('.tm-cross').hidden = true;
    const tip = svg.parentElement.querySelector('.tm-tip');
    if (tip.dataset.orig) { tip.innerHTML = tip.dataset.orig.trim(); delete tip.dataset.orig; }
  }
  $app.addEventListener('pointermove', onPoint);
  $app.addEventListener('pointerdown', onPoint);
  $app.addEventListener('pointerleave', onLeave, true);
  $app.addEventListener('pointercancel', onLeave, true);

  current.refresh = draw;
  current.cleanup = () => {
    $app.removeEventListener('pointermove', onPoint);
    $app.removeEventListener('pointerdown', onPoint);
    $app.removeEventListener('pointerleave', onLeave, true);
    $app.removeEventListener('pointercancel', onLeave, true);
  };
  draw();
  refreshAlbum(albumId);
}

// 自分の最後の釣行の日付（無ければ「ー」）
function lastTripText(albumId, memberId) {
  const t = tripsOf(albumId).filter(x => x.member_id === memberId).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];
  if (!t) return 'ー';
  const d = new Date(t.started_at);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function viewTrip(albumId) {
  const st = stateOf(albumId);
  const session = sessionFor(albumId);
  let timer = null;

  function draw() {
    const trip = activeTrip(albumId);
    const unsent = outbox(albumId);
    const hm = d => `${d.getHours()}:${pad(d.getMinutes())}`;
    const myTripCatches = t => catchesOf(albumId).filter(c => c.trip_id === t.trip_id
      || (!c.trip_id && Date.parse(c.caught_at) >= Date.parse(t.started_at) && (c.angler_member_id === session.member_id)));
    // 画面いっぱいの海。カードは出さない（過去の釣行は地図の「ルート」から見る・消す）
    let notes = '';
    if (st.error && st.error.code === 'invalid_token') notes += invalidTokenBox(albumId);
    if (unsent.length) {
      notes += `<div class="notice info"><p>送信待ちの釣行が${unsent.length}件あります（電波が戻ったら送ります）。</p>
        <button class="btn small" id="resend-btn">今すぐ送る</button></div>`;
    }
    let hero;
    if (trip) {
      const started = new Date(trip.started_at);
      const catches = myTripCatches(trip);
      const mins = Math.max(0, Math.floor((Date.now() - started) / 60000));
      hero = `<section class="trip-hero live">
          <div class="hero-top">
            <p class="trip-state"><span class="rec-dot"></span>釣行中</p>
            <p class="big-time">${Math.floor(mins / 60)}:${pad(mins % 60)}</p>
            <p class="big-label">経過時間</p>
            <div class="trip-stats">
              <div><b>${hm(started)}</b><span>開始</span></div>
              <div><b>${catches.length}</b><span>釣果</span></div>
              <div><b>${trip.points.length}</b><span>記録した地点</span></div>
            </div>
          </div>
          <div class="hero-bottom">
            <div class="trip-controls">
              <a class="round-btn" href="#/a/${esc(albumId)}/new" aria-label="釣果を登録">${icon('plus')}<span>登録</span></a>
              <button class="go-btn coral" id="hit-btn">釣れた！</button>
              <button class="round-btn" id="end-btn" aria-label="釣行を終了">${icon('stop')}<span>終了</span></button>
            </div>
            <p class="hero-note">「釣れた！」で、今の時刻と現在地だけの下書きを作ります</p>
          </div>
        </section>`;
    } else {
      hero = `<section class="trip-hero">
          <div class="hero-top">
            <p class="big-label">釣行</p>
            <p class="hero-greet">今日はどこで釣る？</p>
            <div class="trip-stats summary">
              <div><b>${tripsOf(albumId).filter(t => t.member_id === session.member_id).length}</b><span>あなたの釣行</span></div>
              <div><b>${catchesOf(albumId).filter(c => c.species).reduce((k, c) => k + (Number(c.count) || 1), 0)}<small>匹</small></b><span>アルバムの釣果</span></div>
              <div><b>${lastTripText(albumId, session.member_id)}</b><span>前回の釣行</span></div>
            </div>
          </div>
          <div class="hero-bottom">
            <button class="go-btn" id="start-btn">開始</button>
            <p class="hero-note">開始・終了の時刻と位置を記録します。ルートは地図の「ルート」から見られます</p>
            <p class="hero-privacy">位置を記録するのは、開始・終了、アプリを開いたとき、「釣れた！」・釣果登録のときだけです（自分の位置のみ・釣行中のみ。見られるのはアルバムのメンバーだけ）。</p>
          </div>
        </section>`;
    }

    $app.innerHTML = `${albumTopbar(albumId)}<main class="trip-page">${notes ? `<div class="trip-notes">${notes}</div>` : ''}${hero}</main>${tabbar(albumId, 'trip')}`;

    const start = document.getElementById('start-btn');
    if (start) start.addEventListener('click', async () => {
      busy(true, '現在地を取得しています…');
      const res = await startTrip(albumId, session.member_id);
      busy(false);
      toast(res.point ? '釣行を開始しました' : '釣行を開始しました（現在地は取れませんでした）', 3500);
      draw();
    });
    const hit = document.getElementById('hit-btn');
    if (hit) hit.addEventListener('click', async () => {
      if (navigator.vibrate) navigator.vibrate(20);
      busy(true, '現在地を取得しています…');
      const res = await addHitDraft(albumId);
      busy(false);
      if (!res || !res.draft) toast('現在地が取れず、下書きを作れませんでした。位置情報の設定を確認してください', 5000);
      else toast(res.fallback ? '下書きを作りました（現在地が取れなかったため、最後に記録した地点を使いました）' : '下書きを作りました。写真や魚種はあとから入れられます', 4000);
      draw();
    });
    const end = document.getElementById('end-btn');
    if (end) end.addEventListener('click', async () => {
      if (!confirm('釣行を終了しますか？')) return;
      busy(true, '終了しています…');
      await endTrip(albumId);
      busy(false);
      toast('釣行を終了しました');
      draw();
      sendTrips(albumId);
    });
    const resend = document.getElementById('resend-btn');
    if (resend) resend.addEventListener('click', () => sendTrips(albumId));
  }

  current.refresh = draw;
  current.cleanup = () => clearInterval(timer);
  timer = setInterval(() => { if (activeTrip(albumId)) draw(); }, 60000); // 経過時間を更新
  draw();
  refreshAlbum(albumId);
  sendTrips(albumId, { quiet: true });
}

// アプリを開いたとき：釣行中なら位置を記録し、終了し忘れを確かめ、送信待ちを送る
let checkingTrips = false;
async function checkTrips() {
  if (checkingTrips) return;
  checkingTrips = true;
  try {
    for (const s of getSessions()) {
      const state = staleState(s.album_id);
      if (state === 'auto') {
        await endTrip(s.album_id, { auto: true });
        toast(`「${s.album_name || 'アルバム'}」の釣行は、開始から12時間たったので自動で終了しました`, 5000);
      } else if (state === 'ask') {
        const t = activeTrip(s.album_id);
        const since = new Date(lastPointTime(t));
        if (!confirm(`「${s.album_name || 'アルバム'}」の釣行が続いています（最後の記録 ${since.getHours()}:${pad(since.getMinutes())}）。\n釣行を続けますか？\n（キャンセルすると、最後の記録の時刻で終了します）`)) {
          await endTrip(s.album_id, { auto: true });
          toast('釣行を終了しました');
        } else {
          await recordOpen(s.album_id);
        }
      } else if (activeTrip(s.album_id)) {
        await recordOpen(s.album_id);
      }
      if (outbox(s.album_id).length) await sendTrips(s.album_id, { quiet: true });
    }
  } finally {
    checkingTrips = false;
    if (current.albumId) notify(current.albumId);
  }
}

// ---------- 設定 ----------

function viewSettings(albumId) {
  const st = stateOf(albumId);
  const session = sessionFor(albumId);

  function draw() {
    const s = sessionFor(albumId);
    const invites = (st.data && st.data.invites) || [];
    const members = ((st.data && st.data.members) || []).filter(m => m.joined);
    $app.innerHTML = `${topbar('設定', { back: `#/a/${albumId}/list` })}
      <main class="page">
        ${st.error && st.error.code === 'invalid_token' ? invalidTokenBox(albumId) : ''}
        <section class="card">
          <h2>アルバム</h2>
          <p class="muted small">アルバム名とアイコン画像を変えられます（メンバー全員の画面で変わります）。</p>
          <a class="btn block" href="#/a/${esc(albumId)}/edit">${icon('edit')} アルバム名・アイコンを編集</a>
        </section>

        <form id="name-form" class="card form">
          <h2>表示名</h2>
          <p class="muted small">「${esc(albumTitle(albumId))}」での、あなたの名前です。</p>
          <div class="row"><input name="display_name" maxlength="30" required value="${esc(s.display_name)}">
          <button class="btn primary" type="submit">変更</button></div>
        </form>

        <section class="card">
          <h2>自分の招待リンク</h2>
          <p class="muted small">機種変更したときや、ホーム画面に追加したアプリで開き直すときに使います。<b>他の人には教えないでください</b>（このリンクを開いた人は、あなたとして入れます）。</p>
          <button class="btn" id="show-mine">表示する</button>
          <div id="mine" hidden>${shareBlock(s.token, 'あなた用のリンク')}</div>
        </section>

        <section class="card form" id="members-card">
          <h2>メンバー</h2>
          <p class="member-names">${members.map(m => `<span class="chip">${esc(m.display_name || '（名前なし）')}${m.member_id === s.member_id ? '（あなた）' : ''}</span>`).join('')}</p>
          <form id="invite-form">
            <label>友達を招待する
              <input name="friend_name" maxlength="30" placeholder="友達の名前（本人があとで変えられます）">
            </label>
            <button class="btn primary block" type="submit">${icon('plus')} 招待リンクを作る</button>
          </form>
          <p class="muted small">友達1人につき1つのリンクを作って送ってください（リンクを開いた人がその友達として参加します）。</p>
        </section>

        ${invites.length ? `<section class="card" id="invites-card">
          <h2>まだ参加していない友達</h2>
          ${invites.map(i => shareBlock(i.token, `${i.display_name || '友達'}さん用の招待リンク`)).join('')}
        </section>` : ''}

        <section class="card form">
          <h2>地図の初期レイヤー</h2>
          <select id="layer-select">${Object.entries(LAYERS).map(([k, d]) => `<option value="${k}" ${getSettings().layer === k ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        </section>
      </main>`;

    document.getElementById('show-mine').addEventListener('click', e => {
      document.getElementById('mine').hidden = false;
      e.currentTarget.hidden = true;
    });
    document.getElementById('layer-select').addEventListener('change', e => {
      saveSettings({ layer: e.target.value });
      toast('保存しました');
    });
    const inviteForm = document.getElementById('invite-form');
    inviteForm.addEventListener('submit', async e => {
      e.preventDefault();
      busy(true, '招待リンクを作っています…');
      try {
        const res = await api('createInvite', { token: session.token, display_name: inviteForm.elements.friend_name.value.trim() });
        if (st.data) {
          st.data.invites = [...(st.data.invites || []), res.invite];
          st.data.members = [...(st.data.members || []), res.member];
          saveStateCache(albumId);
        }
        draw();
        const card = document.getElementById('invites-card');
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('招待リンクを作りました。LINEなどで送ってください', 4000);
      } catch (err) {
        toast(err.code === 'bad_action' ? 'サーバーの更新がまだです。少し待ってからもう一度試してください' : err.message, 4000);
      } finally {
        busy(false);
      }
    });
    const form = document.getElementById('name-form');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const name = form.elements.display_name.value.trim();
      if (!name) return toast('表示名を入力してください');
      busy(true, '変更しています…');
      try {
        const res = await api('updateMe', { token: session.token, display_name: name });
        updateSession(albumId, { display_name: res.me.display_name });
        if (st.data) {
          st.data.members = st.data.members.map(m => (m.member_id === res.me.member_id ? { ...m, display_name: res.me.display_name } : m));
          st.data.me = res.me;
          saveStateCache(albumId);
        }
        toast('変更しました');
      } catch (err) {
        toast(err.message, 4000);
      } finally {
        busy(false);
      }
    });
  }

  current.refresh = draw;
  draw();
  refreshAlbum(albumId);
}

// ---------- アルバム名・アイコン画像の編集 ----------

function viewAlbumEdit(albumId) {
  const st = stateOf(albumId);
  const session = sessionFor(albumId);
  let cover = null;     // 今のアイコン：{kind:'existing', f, t} / {kind:'new', full, thumb, previewUrl} / null
  let iconChanged = false;
  let dirty = false;
  let drawn = false;
  const created = [];   // この画面で作ったプレビューURL（画面を閉じたら解放）

  function preview() {
    if (!cover) return icon('map');
    return cover.kind === 'existing' ? photoImg(cover.t, 400) : `<img src="${cover.previewUrl}" alt="">`;
  }

  function draw() {
    if (!st.data) {
      $app.innerHTML = `${topbar('アルバムを編集', { back: '#/' })}<main class="page">
        ${st.error ? (st.error.code === 'invalid_token' ? invalidTokenBox(albumId) : errorBox(st.error.message)) : '<div class="skeleton-card"></div>'}</main>`;
      return;
    }
    drawn = true;
    const album = st.data.album;
    if (!iconChanged) cover = album.icon ? { kind: 'existing', f: album.icon.f, t: album.icon.t } : null;
    $app.innerHTML = `${topbar('アルバムを編集', { back: '#/' })}
      <main class="page">
        ${st.error && st.error.code === 'invalid_token' ? invalidTokenBox(albumId) : ''}
        <form id="album-form" class="card form" novalidate>
          <h2>アイコン画像</h2>
          <div class="icon-edit">
            <div class="album-thumb large" id="icon-preview">${preview()}</div>
            <div class="icon-edit-btns">
              <label class="btn">${icon('camera')} 画像を選ぶ
                <input type="file" accept="image/*" hidden id="icon-input">
              </label>
              <button type="button" class="btn text" id="icon-clear" ${cover ? '' : 'hidden'}>画像を外す</button>
            </div>
          </div>
          <p class="muted small">画像の真ん中を正方形に切り抜いて使います。設定しないときは、最新の釣果の写真がアルバム一覧に表示されます。</p>
          <label>アルバム名 <span class="req">必須</span>
            <input name="name" required maxlength="50" value="${esc(album.name)}">
          </label>
          <button class="btn primary block big" type="submit">保存する</button>
        </form>
        <p class="muted small center">アルバム名とアイコン画像は、メンバー全員の画面で変わります。</p>
      </main>`;

    const form = document.getElementById('album-form');
    const input = document.getElementById('icon-input');
    const clear = document.getElementById('icon-clear');
    const redrawIcon = () => {
      document.getElementById('icon-preview').innerHTML = preview();
      clear.hidden = !cover;
    };

    form.addEventListener('input', () => { dirty = true; });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      busy(true, '画像を準備しています…');
      try {
        const p = await prepareIcon(file);
        created.push(p.previewUrl);
        cover = { kind: 'new', ...p };
        iconChanged = true;
        dirty = true;
        redrawIcon();
      } catch (e) {
        toast(e.message, 4000);
      } finally {
        busy(false);
      }
    });
    clear.addEventListener('click', () => {
      cover = null;
      iconChanged = true;
      dirty = true;
      redrawIcon();
    });

    // 戻るときに入力が消える確認
    $app.querySelector('[data-back]').addEventListener('click', e => {
      if (dirty && !confirm('変更した内容を破棄して戻りますか？')) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const name = form.elements.name.value.trim();
      if (!name) return toast('アルバム名を入力してください');
      busy(true, cover && cover.kind === 'new' ? '画像を送っています…' : '保存しています…');
      try {
        const payload = { token: session.token, name };
        if (iconChanged) payload.icon = cover ? (await uploadPhotos(session.token, [cover], null))[0] : null;
        busy(true, '保存しています…');
        const res = await api('updateAlbum', payload);
        st.data.album = { ...st.data.album, ...res.album };
        saveStateCache(albumId);
        updateSession(albumId, { album_name: res.album.name });
        setHomeCache(getHomeCache().map(x => (x.album_id === albumId ? { ...x, album_name: res.album.name, album_icon: res.album.icon } : x)));
        dirty = false;
        toast('保存しました');
        goBack('#/');
      } catch (err) {
        toast(err.message, 4000);
      } finally {
        busy(false);
      }
    });
  }

  // 読み込みが終わったら描き直す（入力中なら消さないようにそのまま）
  current.refresh = () => { if (!drawn || !dirty) draw(); };
  current.cleanup = () => created.forEach(u => URL.revokeObjectURL(u));
  draw();
  refreshAlbum(albumId);
}

// ---------- 起動 ----------

function start() {
  // 招待リンク（?invite=…）で開かれたら、トークンを控えて URL から消す
  const params = new URLSearchParams(location.search);
  const invite = extractInviteToken(params.get('invite') ? 'invite=' + params.get('invite') : '');
  if (invite) {
    sessionStorage.setItem(INVITE_KEY, invite);
    history.replaceState(null, '', appBaseUrl() + '#/join');
  } else if (location.search) {
    history.replaceState(null, '', appBaseUrl() + location.hash);
  }
  render();
  checkTrips();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkTrips(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('Service Worker の登録に失敗', e));
  }
}

start();
