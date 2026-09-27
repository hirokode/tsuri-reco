// Tsuri Reco の画面。URL の # 以降で画面を切り替える。
//   #/                     ホーム（アルバム一覧）
//   #/start                アルバムを作る／招待リンクを貼り付けて参加
//   #/join                 招待から参加
//   #/a/<id>/invite        招待リンクを送る（アルバム作成直後）
//   #/a/<id>/map | list    アルバム（地図／一覧）
//   #/a/<id>/new?lat=&lng= 釣果の登録
//   #/a/<id>/c/<cid>       詳細
//   #/a/<id>/c/<cid>/edit  編集
//   #/a/<id>/settings      設定
//   #/a/<id>/edit          アルバム名・アイコン画像の編集

import {
  api, ApiError, getSessions, sessionFor, upsertSession, updateSession, removeSession,
  getSettings, saveSettings, getAlbumCache, setAlbumCache, getHomeCache, setHomeCache
} from './api.js';
import { MAX_PHOTOS, photoImg, preparePhoto, prepareIcon, blobToBase64 } from './photos.js';
import { tideForDate, tideLevel, jstTime } from './tide.js';
import { LAYERS, mapReady, createCatchMap, createPickerMap, createMiniMap, getCurrentPosition } from './map.js';

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
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    map: '<path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z M9 4v13.5 M15 6.5V20"/>',
    list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    camera: '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/>',
    pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0113 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z M13 7l4 4"/>'
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

window.addEventListener('hashchange', () => {
  const hash = location.hash || '#/';
  if (replacing) {
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
  return [...st.pending, ...saved].sort((a, b) => (a.caught_at < b.caught_at ? 1 : a.caught_at > b.caught_at ? -1 : 0));
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

function albumTopbar(albumId) {
  return topbar(albumTitle(albumId), {
    back: '#/',
    right: `<a class="icon-btn" href="#/a/${esc(albumId)}/settings" aria-label="設定">${icon('gear')}</a>`
  });
}

function tabbar(albumId, active) {
  const tab = (key, label, href) => `<a class="tab ${active === key ? 'active' : ''}" href="${href}" ${active === key ? 'aria-current="page"' : ''}>${icon(key)}<span>${label}</span></a>`;
  return `<nav class="tabbar">
    ${tab('map', '地図', `#/a/${albumId}/map`)}
    ${tab('list', '一覧', `#/a/${albumId}/list`)}
    ${tab('plus', '登録', `#/a/${albumId}/new`)}
  </nav>`;
}

function catchThumb(albumId, c) {
  if (c._pending && c._previews && c._previews.length) return `<img src="${c._previews[0]}" alt="">`;
  if (c.photo_ids && c.photo_ids.length) return photoImg(c.photo_ids[0].t, 400);
  return `<div class="thumb-empty">${icon('camera')}</div>`;
}

// 潮位の文言：「約80cm・下げ」と「満潮（3:12）から2時間18分後」
function durationText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`;
}

function tideNowText(r, t) {
  const since = r.prev ? `${r.prev.type}（${jstTime(r.prev.ms)}）から${durationText(t - r.prev.ms)}後` : '';
  return { level: `約${r.level}cm${r.trend ? '・' + r.trend : ''}`, since };
}

// levels：釣れた回ごとの [{ hit, r }]（r＝その時刻の潮位）。満干潮の一覧は最初の回の日のもの
function tideCardHtml(levels) {
  const first = levels[0].r;
  const list = type => first.events.filter(e => e.type === type).map(e => `${jstTime(e.ms)}（${e.h}cm）`).join('　') || 'なし';
  const many = levels.length > 1;
  const nowLines = levels.map(({ hit, r }) => {
    if (!r || r.level == null) return '';
    const now = tideNowText(r, new Date(hit.at).getTime());
    const head = many ? `<span class="tide-hit">${esc(jstTime(new Date(hit.at).getTime()))}（${esc(hit.count)}匹）</span>` : '';
    return `<p class="tide-now">${head}<b>${esc(now.level)}</b> <span class="muted small">${esc(now.since)}</span></p>`;
  }).join('');
  return `<h2>潮位 <span class="muted small">（予測）</span></h2>
    ${nowLines}
    <dl class="fields"><dt>満潮</dt><dd>${esc(list('満潮'))}</dd><dt>干潮</dt><dd>${esc(list('干潮'))}</dd></dl>
    <p class="muted small">${many ? '' : `釣った時刻 ${esc(jstTime(new Date(levels[0].hit.at).getTime()))}・`}${esc(first.station.name)}（約${Math.round(first.km)}km）の予測です。出典：気象庁「潮位表」。川の上流などでは時刻が遅れることがあります。</p>`;
}

// 釣れた回（時刻と匹数）。hits の無い釣果は「日時に匹数ぶん」の1回とみなす
function hitsOf(c) {
  return Array.isArray(c.hits) && c.hits.length ? c.hits : [{ at: c.caught_at, count: c.count || 1 }];
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
  if (c.size_cm != null && c.size_cm !== '') bits.push(`${c.size_cm}cm`);
  if (c.weight_g != null && c.weight_g !== '') bits.push(`${c.weight_g}g`);
  if (c.count > 1) bits.push(`${c.count}匹`);
  return bits.join('・');
}

function catchCard(albumId, c) {
  const status = c._pending === 'sending' ? '<span class="chip">送信中…</span>'
    : c._pending === 'error' ? `<span class="chip error">送信失敗</span>` : '';
  const body = `
    <div class="catch-thumb">${catchThumb(albumId, c)}</div>
    <div class="catch-body">
      <h3>${esc(c.species)} <span class="size">${esc(catchSummary(c))}</span></h3>
      <p class="muted">${esc(c.place_name || '場所名なし')}</p>
      <p class="muted small">${esc(fmtDateTime(c.caught_at))}${hitsOf(c).length > 1 ? '〜' + esc(fmtHitTime(hitsOf(c).at(-1).at, c.caught_at)) : ''}・${esc(memberName(albumId, c.angler_member_id))}</p>
      ${status}
      ${c._pending === 'error' ? `<p class="small error-text">${esc(c._error || '')}</p>
        <div class="row"><button class="btn small" data-retry="${esc(c.catch_id)}">再送する</button>
        <button class="btn small text" data-discard="${esc(c.catch_id)}">取り消す</button></div>` : ''}
    </div>`;
  if (c._pending) return `<div class="catch-card pending">${body}</div>`;
  return `<a class="catch-card" href="#/a/${esc(albumId)}/c/${esc(c.catch_id)}">${body}</a>`;
}

let lastMapView = {}; // アルバムごとの地図の表示位置（タブを行き来しても保つ）

function viewAlbum(albumId, tab) {
  const st = stateOf(albumId);
  $app.innerHTML = `${albumTopbar(albumId)}
    <main class="${tab === 'map' ? 'map-page' : 'page with-tabbar'}" id="album-main"></main>
    ${tab === 'list' ? `<a class="fab" href="#/a/${esc(albumId)}/new" aria-label="釣果を登録">${icon('plus')}</a>` : ''}
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
        <p class="map-hint">地図を長押しすると、その場所で釣果を登録できます</p>`;
      const cm = createCatchMap(document.getElementById('map'), {
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
      current.refresh = () => {
        cm.setCatches(catchesOf(albumId));
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

function mapPopup(albumId, c) {
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `
    <div class="popup-thumb">${catchThumb(albumId, c)}</div>
    <b>${esc(c.species)}</b> ${esc(catchSummary(c))}<br>
    <span class="muted small">${esc(fmtDate(c.caught_at))}・${esc(memberName(albumId, c.angler_member_id))}</span>
    ${c._pending ? '<br><span class="chip">送信中</span>' : `<br><a class="btn small" href="#/a/${esc(albumId)}/c/${esc(c.catch_id)}">詳細を見る</a>`}`;
  return div;
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
      ids.push({ f: p.f, t: p.t });
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
    ids.push(res.photo);
    if (done) done[i] = res.photo;
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
    const { catch_id, _pending, _error, _photos, _uploaded, _previews, ...fields } = p;
    const res = await api('saveCatch', { token: session.token, catch: { ...fields, photo_ids: photoIds } });
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

  // 位置：編集なら元の値、長押しから来たならその座標、それ以外は未設定
  let loc = null;
  if (orig) loc = { lat: orig.lat, lng: orig.lng };
  else if (params.get('lat') && params.get('lng')) loc = parseLatLng(`${params.get('lat')},${params.get('lng')}`);
  const lastCatch = catchesOf(albumId).find(c => isFinite(c.lat));
  let photos = orig ? (orig.photo_ids || []).map(p => ({ kind: 'existing', f: p.f, t: p.t })) : [];
  // 日時：'photo'＝写真の撮影日時を使う（変更不可・既定）、'manual'＝自分で入力
  let dateMode = 'photo';
  // 釣れた回（時刻と匹数）。時刻順に並べ、最初の回＝釣果の日時、合計＝匹数。
  // photo が付いた回が「写真から」の対象（最初は1回目）。base は写真に撮影日時が無いときに使う日時
  const hits = (orig ? hitsOf(orig) : [{ at: new Date().toISOString(), count: 1 }])
    .map((h, i) => ({ at: toLocalInput(new Date(h.at)), count: h.count, photo: i === 0 }));
  const photoBase = hits[0].at;
  let dirty = false;

  const members = st.data.members;
  const anglerId = orig ? orig.angler_member_id : session.member_id;
  const v = orig || {};
  const title = editing ? '釣果を編集' : '釣果を登録';
  const back = editing ? `#/a/${albumId}/c/${catchId}` : `#/a/${albumId}/list`;

  $app.innerHTML = `${topbar(title, { back })}
    <main class="page">
      <form id="catch-form" class="form" novalidate>
        <section class="card">
          <h2>写真 <span class="muted small">（${MAX_PHOTOS}枚まで）</span></h2>
          <div class="photo-grid" id="photo-grid"></div>
          <label class="btn block" id="photo-add">${icon('camera')} 写真を撮る・選ぶ
            <input type="file" accept="image/*" multiple hidden id="photo-input">
          </label>
          <p class="muted small">写真の位置情報は使わず、保存もしません。</p>
        </section>

        <section class="card">
          <h2>釣れた日時・匹数 <span class="req">必須</span></h2>
          <div class="segmented" role="radiogroup" aria-label="日時の入れ方">
            <label><input type="radio" name="date_mode" value="photo" checked><span>写真から</span></label>
            <label><input type="radio" name="date_mode" value="manual"><span>自分で入力</span></label>
          </div>
          <div id="hits" class="hits"></div>
          <p class="muted small" id="date-hint"></p>
          <button class="btn block" type="button" id="hit-add">${icon('plus')} 釣れた回を追加</button>
          <p class="muted small">時間をあけて釣れたときは回を分けて入れてください。時刻の順に自動で並べ替えます。</p>
        </section>

        <section class="card">
          <h2>位置 <span class="req">必須</span></h2>
          <div id="picker" class="picker-map"></div>
          <p class="muted small">地図をタップするとピンが立ちます。ピンはドラッグで動かせます。</p>
          <div class="row">
            <button class="btn" type="button" id="locate-btn">${icon('pin')} 現在地</button>
            <a class="btn" id="gmaps-link" target="_blank" rel="noopener">Googleマップで開く</a>
          </div>
          <label>緯度, 経度（貼り付けOK）
            <input name="coord" inputmode="decimal" placeholder="35.123456, 138.123456" autocomplete="off">
          </label>
        </section>

        <section class="card">
          <label>魚種 <span class="req">必須</span><input name="species" required maxlength="50" value="${esc(v.species)}" placeholder="例：アジ"></label>
          <div class="grid2">
            <label>サイズ(cm)<input name="size_cm" type="number" inputmode="decimal" min="0" step="0.1" value="${esc(v.size_cm ?? '')}"></label>
            <label>重さ(g)<input name="weight_g" type="number" inputmode="decimal" min="0" step="1" value="${esc(v.weight_g ?? '')}"></label>
          </div>
          <label>釣った人 <span class="req">必須</span>
            <select name="angler_member_id">${members.map(m => `<option value="${esc(m.member_id)}" ${m.member_id === anglerId ? 'selected' : ''}>${esc(m.display_name || '（未参加）')}</option>`).join('')}</select>
          </label>
          <label>場所名<input name="place_name" maxlength="100" value="${esc(v.place_name)}" placeholder="例：〇〇港 赤灯台"></label>
          <label>潮
            <select name="tide_name"><option value="">（未選択）</option>${TIDES.map(t => `<option ${v.tide_name === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
          </label>
          <p class="muted small tide-hint" id="tide-hint"></p>
          <p class="small tide-hint" id="tide-level"></p>
          <label>釣り方・仕掛け<input name="method" maxlength="100" value="${esc(v.method)}"></label>
          <label>エサ／ルアー<input name="bait" maxlength="100" value="${esc(v.bait)}"></label>
          <label>メモ<textarea name="memo" maxlength="2000" rows="3">${esc(v.memo)}</textarea></label>
        </section>

        <button class="btn primary block big" type="submit">${editing ? '保存する' : '登録する'}</button>
      </form>
    </main>`;

  const form = document.getElementById('catch-form');
  const grid = document.getElementById('photo-grid');
  const input = document.getElementById('photo-input');
  const coord = form.elements.coord;
  const gmaps = document.getElementById('gmaps-link');
  const created = []; // この画面で作ったプレビューURL（画面を閉じたら解放）

  form.addEventListener('input', () => { dirty = true; });

  // 釣れた回の表示と入力
  const hitsEl = document.getElementById('hits');
  const dateHint = document.getElementById('date-hint');
  const photoDate = () => (photos.find(p => p.kind === 'new' && p.takenAt) || {}).takenAt || null;
  // いちばん早い回（並べ替え前でも）
  const firstDate = () => new Date(hits.reduce((min, h) => (h.at && h.at < min ? h.at : min), hits[0].at));

  function drawHits() {
    const many = hits.length > 1;
    hitsEl.innerHTML = hits.map((h, i) => `<div class="hit-row${moved[i] ? ' moved' : ''}">
      <span class="hit-no">${many ? `${i + 1}回目` : ''}</span>
      <input type="datetime-local" class="hit-at" data-i="${i}" value="${esc(h.at)}" aria-label="${i + 1}回目の時刻" ${h.photo && dateMode === 'photo' ? 'disabled' : ''}>
      <label class="hit-count"><input type="number" inputmode="numeric" min="1" step="1" class="hit-n" data-i="${i}" value="${esc(h.count)}" aria-label="${i + 1}回目の匹数">匹</label>
      ${many ? `<button type="button" class="icon-btn hit-del" data-del-hit="${i}" aria-label="${i + 1}回目を消す">${icon('x')}</button>` : ''}
    </div>`).join('') + (many ? `<p class="hit-total">合計 <b>${hits.reduce((n, h) => n + (Number(h.count) || 0), 0)}</b>匹</p>` : '');
  }

  // 入力欄の今の値を取り込む（描き直す前に。確定前の入力を消さないように）
  function readHits() {
    hitsEl.querySelectorAll('.hit-at').forEach(el => { if (el.value) hits[Number(el.dataset.i)].at = el.value; });
    hitsEl.querySelectorAll('.hit-n').forEach(el => { hits[Number(el.dataset.i)].count = el.value; });
  }

  // 時刻の順に並べる。並びが変わったら知らせて、動いた回を光らせる
  let moved = [];
  function sortHits() {
    const before = hits.slice();
    hits.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    moved = hits.map((h, i) => before[i] !== h);
    if (moved.some(Boolean)) toast('時刻の順に並べ替えました');
  }

  // 並べ替えは、時刻・匹数の欄から離れたとき（同じ回の匹数を続けて入れられるように）
  let needSort = false;
  hitsEl.addEventListener('focusout', e => {
    if (!needSort || hitsEl.contains(e.relatedTarget)) return;
    needSort = false;
    readHits();
    sortHits();
    drawHits();
    moved = [];
  });

  hitsEl.addEventListener('change', e => {
    readHits();
    if (e.target.classList.contains('hit-at')) {
      needSort = true;
      syncTide();
    } else if (e.target.classList.contains('hit-n')) {
      const total = hitsEl.querySelector('.hit-total b');
      if (total) total.textContent = hits.reduce((n, h) => n + (Number(h.count) || 0), 0);
    }
  });
  hitsEl.addEventListener('click', e => {
    const d = e.target.closest('[data-del-hit]');
    if (!d) return;
    readHits();
    const [removed] = hits.splice(Number(d.dataset.delHit), 1);
    if (removed.photo) hits[0].photo = true; // 写真の対象は残った最初の回に移す
    dirty = true;
    drawHits();
    syncDate();
  });
  document.getElementById('hit-add').addEventListener('click', () => {
    readHits();
    sortHits();
    needSort = false;
    hits.push({ at: hits[hits.length - 1].at, count: 1, photo: false });
    dirty = true;
    drawHits();
    const inputs = hitsEl.querySelectorAll('.hit-at');
    inputs[inputs.length - 1].focus();
  });
  // 潮：日付の月齢から潮名を計算する。新規登録では自動で入れる（手で選び直したらそのまま）。
  // 編集では保存済みの値を変えず、計算結果を案内だけする
  const tideSelect = form.elements.tide_name;
  const tideHint = document.getElementById('tide-hint');
  let tideTouched = editing;
  tideSelect.addEventListener('change', () => { tideTouched = true; syncTide(); });
  function syncTide() {
    const d = firstDate();
    if (isNaN(d)) {
      tideHint.textContent = '';
      return;
    }
    const t = tideForDate(d);
    if (!tideTouched) tideSelect.value = t.name;
    const calc = `この日の潮は「${t.name}」（月齢${t.age.toFixed(1)}から計算）。`;
    tideHint.textContent = tideSelect.value === t.name
      ? `${calc}${tideTouched ? '' : '自動で入れました。'}渓流など潮に関係ない釣りは「（未選択）」にしてください。`
      : calc;
    showTideLevel(d);
  }

  // 潮位（予測）：潮を選んでいて、位置が決まっているときだけ
  const tideLevelEl = document.getElementById('tide-level');
  let tideReq = 0;
  function showTideLevel(d) {
    const n = ++tideReq;
    if (!tideSelect.value || !loc) {
      tideLevelEl.textContent = '';
      return;
    }
    tideLevel(loc.lat, loc.lng, d).then(r => {
      if (n !== tideReq) return; // もっと新しい計算が始まっている
      if (!r || r.level == null) {
        tideLevelEl.textContent = '';
        return;
      }
      const now = tideNowText(r, d.getTime());
      tideLevelEl.textContent = `潮位（予測）：${now.level}${now.since ? '・' + now.since : ''}　${r.station.name}（約${Math.round(r.km)}km）`;
    });
  }

  function syncDate() {
    if (hitsEl.querySelector('.hit-at')) readHits();
    const auto = dateMode === 'photo';
    if (!auto) {
      dateHint.textContent = '日時を自由に変えられます。';
      drawHits();
      syncTide();
      return;
    }
    const d = photoDate();
    hits.find(h => h.photo).at = d ? toLocalInput(d) : photoBase;
    sortHits();
    drawHits();
    moved = [];
    const fallback = editing ? '保存済みの日時' : '今の日時';
    dateHint.textContent = d ? `写真の撮影日時を使っています${hits.length > 1 ? '（ロックされている回）' : ''}。`
      : photos.some(p => p.kind === 'new') ? `写真に撮影日時が無いため、${fallback}を使います。`
      : `写真を選ぶと撮影日時が入ります（それまでは${fallback}）。`;
    syncTide();
  }
  form.querySelectorAll('input[name="date_mode"]').forEach(r => r.addEventListener('change', () => {
    dateMode = r.value;
    syncDate();
    if (dateMode === 'manual') hitsEl.querySelector('.hit-at').focus();
  }));

  function drawPhotos() {
    grid.innerHTML = photos.map((p, i) => `<div class="photo-item">
      ${p.kind === 'existing' ? photoImg(p.t, 400) : `<img src="${p.previewUrl}" alt="">`}
      <button type="button" class="photo-del" data-del="${i}" aria-label="写真を外す">${icon('x')}</button></div>`).join('');
    document.getElementById('photo-add').hidden = photos.length >= MAX_PHOTOS;
  }
  grid.addEventListener('click', e => {
    const d = e.target.closest('[data-del]');
    if (!d) return;
    photos.splice(Number(d.dataset.del), 1);
    dirty = true;
    drawPhotos();
    syncDate();
  });
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = '';
    const room = MAX_PHOTOS - photos.length;
    if (files.length > room) toast(`写真は${MAX_PHOTOS}枚までです。${room}枚だけ追加します`);
    busy(true, '写真を準備しています…');
    try {
      for (const file of files.slice(0, room)) {
        const p = await preparePhoto(file);
        created.push(p.previewUrl);
        if (dateMode === 'photo' && p.takenAt && !photoDate()) toast('写真の撮影日時を入れました');
        photos.push({ kind: 'new', ...p });
      }
      dirty = true;
    } catch (e) {
      toast(e.message, 4000);
    } finally {
      busy(false);
      drawPhotos();
      syncDate();
    }
  });
  drawPhotos();
  syncDate();

  // 位置
  let picker = null;
  function setLoc(value, { fromPicker = false, fromText = false } = {}) {
    loc = value ? { lat: Number(value.lat.toFixed(6)), lng: Number(value.lng.toFixed(6)) } : null;
    if (!fromText) coord.value = loc ? fmtCoord(loc.lat, loc.lng) : '';
    if (loc && picker && !fromPicker) picker.set(loc);
    gmaps.href = loc ? googleMapsUrl(loc.lat, loc.lng) : '#';
    gmaps.classList.toggle('disabled', !loc);
    syncTide();
  }
  if (mapReady()) {
    picker = createPickerMap(document.getElementById('picker'), {
      layerKey: settings.layer,
      value: loc,
      fallbackCenter: lastCatch ? { lat: lastCatch.lat, lng: lastCatch.lng } : null,
      onChange: ll => { dirty = true; setLoc(ll, { fromPicker: true }); }
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
    setLoc(ll);
  });
  coord.addEventListener('paste', () => setTimeout(() => coord.dispatchEvent(new Event('change')), 0));
  document.getElementById('locate-btn').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const p = await getCurrentPosition();
      dirty = true;
      setLoc(p);
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

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = form.elements;
    readHits();
    needSort = false;
    if (hits.some(h => !h.at || isNaN(new Date(h.at)))) return toast('釣れた時刻を入力してください');
    if (hits.some(h => !Number.isInteger(Number(h.count)) || Number(h.count) < 1)) return toast('匹数は1以上の整数で入力してください');
    sortHits();
    const caught = firstDate();
    if (coord.value.trim()) {
      const typed = parseLatLng(coord.value);
      if (!typed) return toast('緯度経度の形が正しくありません（例：35.123, 138.123）');
      setLoc(typed);
    }
    if (!loc) return toast('位置を指定してください（地図をタップ・現在地・緯度経度）');
    if (!f.species.value.trim()) return toast('魚種を入力してください');
    const count = hits.reduce((n, h) => n + Number(h.count), 0);

    const fields = {
      caught_at: toLocalIso(caught),
      lat: loc.lat,
      lng: loc.lng,
      place_name: f.place_name.value.trim(),
      species: f.species.value.trim(),
      size_cm: f.size_cm.value === '' ? '' : Number(f.size_cm.value),
      weight_g: f.weight_g.value === '' ? '' : Number(f.weight_g.value),
      count,
      hits: hits.map(h => ({ at: toLocalIso(new Date(h.at)), count: Number(h.count) })),
      angler_member_id: f.angler_member_id.value,
      tide_name: f.tide_name.value,
      method: f.method.value.trim(),
      bait: f.bait.value.trim(),
      memo: f.memo.value.trim()
    };

    if (!editing) {
      // 先に一覧に出して、裏で送る
      const p = {
        ...fields,
        catch_id: 'tmp-' + Date.now(),
        size_cm: fields.size_cm === '' ? null : fields.size_cm,
        weight_g: fields.weight_g === '' ? null : fields.weight_g,
        photo_ids: [],
        _pending: 'sending',
        _photos: photos.slice(),
        _uploaded: [],
        _previews: photos.filter(x => x.kind === 'new').map(x => x.previewUrl)
      };
      st.pending.push(p);
      dirty = false;
      replaceHash(`#/a/${albumId}/list`);
      sendPending(albumId, p);
      return;
    }

    busy(true, photos.some(p => p.kind === 'new') ? '写真を送っています…' : '保存しています…');
    try {
      const photoIds = await uploadPhotos(session.token, photos, null);
      busy(true, '保存しています…');
      const payload = { token: session.token, catch: { ...fields, catch_id: catchId, photo_ids: photoIds }, base_updated_at: orig.updated_at };
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
    const photos = c.photo_ids || [];
    const rows = [
      ['日時', fmtDateTime(c.caught_at)],
      ['釣れた時刻', hitsOf(c).length > 1 ? hitsOf(c).map(h => `${fmtHitTime(h.at, c.caught_at)} ${h.count}匹`).join('　') : ''],
      ['釣った人', memberName(albumId, c.angler_member_id)],
      ['場所名', c.place_name],
      ['サイズ', c.size_cm != null ? `${c.size_cm} cm` : ''],
      ['重さ', c.weight_g != null ? `${c.weight_g} g` : ''],
      ['匹数', `${c.count} 匹`],
      ['潮', c.tide_name],
      ['釣り方・仕掛け', c.method],
      ['エサ／ルアー', c.bait]
    ].filter(r => r[1] !== '' && r[1] != null);

    $app.innerHTML = `${topbar(c.species, { back: `#/a/${albumId}/list` })}
      <main class="page detail">
        ${photos.length ? `<div class="gallery" id="gallery">${photos.map(p => `<div class="slide">${photoImg(p.f, 1600)}</div>`).join('')}</div>
          ${photos.length > 1 ? `<div class="dots" id="dots">${photos.map((_, i) => `<span class="${i === 0 ? 'on' : ''}"></span>`).join('')}</div>` : ''}` : ''}
        <section class="card">
          <h2>${esc(c.species)} <span class="size">${esc(catchSummary(c))}</span></h2>
          <dl class="fields">${rows.map(r => `<dt>${esc(r[0])}</dt><dd>${esc(r[1])}</dd>`).join('')}</dl>
          ${c.memo ? `<p class="memo">${esc(c.memo)}</p>` : ''}
        </section>
        ${c.tide_name ? '<section class="card" id="tide-card" hidden></section>' : ''}
        <section class="card">
          <div id="mini-map" class="mini-map"></div>
          <p class="muted small">${esc(fmtCoord(c.lat, c.lng))}</p>
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

    const tideCard = document.getElementById('tide-card');
    if (tideCard) {
      const list = hitsOf(c);
      Promise.all(list.map(hit => tideLevel(c.lat, c.lng, new Date(hit.at)).then(r => ({ hit, r })))).then(levels => {
        if (!tideCard.isConnected || !levels[0].r || levels[0].r.level == null) return;
        tideCard.innerHTML = tideCardHtml(levels);
        tideCard.hidden = false;
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
      if (!confirm(`「${c.species}」の釣果を削除しますか？`)) return;
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

// ---------- 設定 ----------

function viewSettings(albumId) {
  const st = stateOf(albumId);
  const session = sessionFor(albumId);

  function draw() {
    const s = sessionFor(albumId);
    const invites = (st.data && st.data.invites) || [];
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

        ${invites.length ? `<section class="card">
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('Service Worker の登録に失敗', e));
  }
}

start();
