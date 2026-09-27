// 各 API の中身。createAlbum・getInvite 以外は、毎回トークンを確認し、
// そのトークンが属するアルバムのデータだけを扱う。

const MAX_ALBUMS_PER_DAY = 20; // アプリ全体で1日に作れるアルバム数（乱用対策）
const MAX_PHOTOS = 5;
const MAX_HITS = 50; // 1件の釣果に入れられる「釣れた回」の数
const TIDE_NAMES = ['', '大潮', '中潮', '小潮', '長潮', '若潮'];

// ---------- アルバム・メンバー ----------

function apiCreateAlbum_(req) {
  const myName = text_(req.my_name, 30, 'あなたの名前', true);
  const friendName = text_(req.friend_name, 30, '友達の名前', false);
  const albumName = text_(req.album_name, 50, 'アルバム名', false) || (friendName || '友達') + 'との釣り';

  return withLock_(function () {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = readRows_('albums').filter(function (a) { return Date.parse(a.created_at) > since; });
    if (recent.length >= MAX_ALBUMS_PER_DAY) {
      throw apiError_('rate_limited', '今日はこれ以上アルバムを作れません。明日もう一度試してください');
    }
    const now = now_();
    const albumId = Utilities.getUuid();
    const folder = getRootFolder_().createFolder(albumName + ' (' + albumId.slice(0, 8) + ')');
    appendRow_('albums', { album_id: albumId, name: albumName, created_at: now, drive_folder_id: folder.getId() });

    const me = { member_id: Utilities.getUuid(), album_id: albumId, display_name: myName, token: newToken_(), joined_at: now };
    const friend = { member_id: Utilities.getUuid(), album_id: albumId, display_name: friendName, token: newToken_(), joined_at: '' };
    appendRow_('members', me);
    appendRow_('members', friend);
    return {
      album_id: albumId,
      album_name: albumName,
      me: { member_id: me.member_id, token: me.token, display_name: myName },
      invite: { member_id: friend.member_id, token: friend.token, display_name: friendName }
    };
  });
}

// 招待リンクを開いたときの表示用（まだ参加していなくても見られる）
function apiGetInvite_(req) {
  const me = auth_(req.token);
  const album = albumRow_(me.album_id);
  const members = readRows_('members').filter(function (m) { return m.album_id === me.album_id; });
  return {
    album_id: album.album_id,
    album_name: album.name,
    you: publicMember_(me),
    members: members.map(publicMember_)
  };
}

function apiJoin_(req) {
  const name = text_(req.display_name, 30, '表示名', true);
  return withLock_(function () {
    const me = auth_(req.token);
    me.display_name = name;
    if (!me.joined_at) me.joined_at = now_();
    updateRow_('members', me._row, me);
    const album = albumRow_(me.album_id);
    return { album_id: album.album_id, album_name: album.name, me: publicMember_(me) };
  });
}

function apiUpdateMe_(req) {
  const name = text_(req.display_name, 30, '表示名', true);
  return withLock_(function () {
    const me = auth_(req.token);
    me.display_name = name;
    updateRow_('members', me._row, me);
    return { me: publicMember_(me) };
  });
}

// アルバム名・アイコン画像の変更（メンバーなら誰でもできる）。
// icon：{f,t} で設定、null で外す、送られてこなければそのまま
function apiUpdateAlbum_(req) {
  const name = text_(req.name, 50, 'アルバム名', true);
  const hasIcon = Object.prototype.hasOwnProperty.call(req, 'icon');
  const icon = hasIcon ? cleanIcon_(req.icon) : null;
  return withLock_(function () {
    const me = auth_(req.token);
    const album = albumRow_(me.album_id);
    album.name = name;
    if (hasIcon) album.icon_photo = icon ? JSON.stringify(icon) : '';
    updateRow_('albums', album._row, album);
    return { album: publicAlbum_(album) };
  });
}

function cleanIcon_(p) {
  if (p === null || p === undefined || p === '') return null;
  if (!validFileId_(p.f) || !validFileId_(p.t)) throw apiError_('invalid', 'アイコン画像の情報が正しくありません');
  return { f: p.f, t: p.t };
}

// ホーム画面用。端末が持っているトークンそれぞれについて、アルバムの概要を返す
function apiListAlbums_(req) {
  const tokens = Array.isArray(req.tokens) ? req.tokens.slice(0, 30) : [];
  const members = readRows_('members');
  const albums = readRows_('albums');
  const catches = readRows_('catches').filter(function (c) { return c.deleted !== 'true'; });
  return tokens.map(function (token) {
    const me = validToken_(token) ? members.filter(function (m) { return m.token === token; })[0] : null;
    if (!me) return { token: token, valid: false };
    const album = albums.filter(function (a) { return a.album_id === me.album_id; })[0];
    if (!album) return { token: token, valid: false };
    const list = catches.filter(function (c) { return c.album_id === album.album_id; });
    list.sort(function (a, b) { return a.caught_at < b.caught_at ? 1 : -1; });
    const latest = list[0] ? publicCatch_(list[0]) : null;
    return {
      token: token,
      valid: true,
      album_id: album.album_id,
      album_name: album.name,
      album_icon: parseJson_(album.icon_photo, null),
      me: publicMember_(me),
      members: members.filter(function (m) { return m.album_id === album.album_id; }).map(publicMember_),
      catch_count: list.length,
      last_caught_at: latest ? latest.caught_at : '',
      last_photo: latest && latest.photo_ids.length ? latest.photo_ids[0] : null
    };
  });
}

// アルバム画面用。メンバー・釣果（削除済みを除く）・未参加メンバーの招待トークンを返す
function apiGetAlbum_(req) {
  const me = auth_(req.token);
  const album = albumRow_(me.album_id);
  const members = readRows_('members').filter(function (m) { return m.album_id === album.album_id; });
  const catches = readRows_('catches').filter(function (c) {
    return c.album_id === album.album_id && c.deleted !== 'true';
  });
  return {
    album: publicAlbum_(album),
    me: publicMember_(me),
    members: members.map(publicMember_),
    invites: members.filter(function (m) { return !m.joined_at; }).map(function (m) {
      return { member_id: m.member_id, display_name: m.display_name, token: m.token };
    }),
    catches: catches.map(publicCatch_),
    server_time: now_()
  };
}

// ---------- 釣果 ----------

function apiSaveCatch_(req) {
  const input = req.catch || {};
  return withLock_(function () {
    const me = auth_(req.token);
    const members = readRows_('members').filter(function (m) { return m.album_id === me.album_id; });
    const fields = cleanCatch_(input, members);
    const now = now_();

    if (!input.catch_id) {
      const row = Object.assign({
        catch_id: Utilities.getUuid(),
        album_id: me.album_id,
        tide_events: '',
        created_by: me.member_id,
        created_at: now,
        updated_by: me.member_id,
        updated_at: now,
        deleted: 'false'
      }, fields);
      appendRow_('catches', row);
      return { catch: publicCatch_(row) };
    }

    const row = catchRow_(input.catch_id, me.album_id);
    checkConflict_(row, req);
    Object.assign(row, fields, { updated_by: me.member_id, updated_at: now });
    updateRow_('catches', row._row, row);
    return { catch: publicCatch_(row) };
  });
}

function apiDeleteCatch_(req) {
  return withLock_(function () {
    const me = auth_(req.token);
    const row = catchRow_(req.catch_id, me.album_id);
    checkConflict_(row, req);
    Object.assign(row, { deleted: 'true', updated_by: me.member_id, updated_at: now_() });
    updateRow_('catches', row._row, row);
    return { catch_id: row.catch_id };
  });
}

// 編集を始めたときの updated_at と今の値が違えば、他の人が先に更新している
function checkConflict_(row, req) {
  if (req.force) return;
  if (req.base_updated_at && req.base_updated_at !== row.updated_at) {
    throw apiError_('conflict', '他の人が先にこの釣果を更新しています', { latest: publicCatch_(row) });
  }
}

function catchRow_(catchId, albumId) {
  const row = readRows_('catches').filter(function (c) {
    return c.catch_id === catchId && c.album_id === albumId && c.deleted !== 'true';
  })[0];
  if (!row) throw apiError_('not_found', 'この釣果は見つかりません（削除された可能性があります）');
  return row;
}

// 画面から来た値を確認・整形する。ここを通った値だけをシートに書く
function cleanCatch_(c, members) {
  let caughtAt = text_(c.caught_at, 40, '日時', true);
  if (isNaN(Date.parse(caughtAt))) throw apiError_('invalid', '日時の形式が正しくありません');
  const lat = num_(c.lat, -90, 90, '緯度', true);
  const lng = num_(c.lng, -180, 180, '経度', true);
  const angler = text_(c.angler_member_id, 60, '釣った人', true);
  if (!members.some(function (m) { return m.member_id === angler; })) {
    throw apiError_('invalid', '釣った人がアルバムのメンバーではありません');
  }
  const tide = text_(c.tide_name, 10, '潮', false);
  if (TIDE_NAMES.indexOf(tide) < 0) throw apiError_('invalid', '潮の値が正しくありません');
  const photos = Array.isArray(c.photo_ids) ? c.photo_ids : [];
  if (photos.length > MAX_PHOTOS) throw apiError_('invalid', '写真は' + MAX_PHOTOS + '枚までです');
  const cleanPhotos = photos.map(function (p) {
    if (!p || !validFileId_(p.f) || !validFileId_(p.t)) throw apiError_('invalid', '写真の情報が正しくありません');
    return { f: p.f, t: p.t };
  });
  let count = num_(c.count, 1, 9999, '匹数', true);
  if (Math.floor(count) !== count) throw apiError_('invalid', '匹数は整数で入力してください');
  // 釣れた回（時刻と匹数）。時刻順に並べ、日時＝最初の回、匹数＝合計にそろえる
  const hits = cleanHits_(c.hits);
  if (hits.length) {
    caughtAt = hits[0].at;
    count = hits.reduce(function (sum, h) { return sum + h.count; }, 0);
  }
  return {
    caught_at: caughtAt,
    lat: lat,
    lng: lng,
    place_name: text_(c.place_name, 100, '場所名', false),
    species: text_(c.species, 50, '魚種', true),
    size_cm: num_(c.size_cm, 0, 1000, 'サイズ', false),
    weight_g: num_(c.weight_g, 0, 1000000, '重さ', false),
    count: count,
    angler_member_id: angler,
    tide_name: tide,
    method: text_(c.method, 100, '釣り方・仕掛け', false),
    bait: text_(c.bait, 100, 'エサ／ルアー', false),
    memo: text_(c.memo, 2000, 'メモ', false),
    photo_ids: JSON.stringify(cleanPhotos),
    hits: hits.length > 1 ? JSON.stringify(hits) : ''
  };
}

function cleanHits_(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > MAX_HITS) throw apiError_('invalid', '釣れた回は' + MAX_HITS + '回までです');
  const hits = list.map(function (h) {
    const at = text_(h && h.at, 40, '釣れた時刻', true);
    if (isNaN(Date.parse(at))) throw apiError_('invalid', '釣れた時刻の形式が正しくありません');
    const count = num_(h.count, 1, 9999, '匹数', true);
    if (Math.floor(count) !== count) throw apiError_('invalid', '匹数は整数で入力してください');
    return { at: at, count: count };
  });
  hits.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
  return hits;
}

// ---------- 共通 ----------

function auth_(token) {
  if (!validToken_(token)) throw apiError_('invalid_token', '招待リンクが正しくありません');
  const me = readRows_('members').filter(function (m) { return m.token === token; })[0];
  if (!me) throw apiError_('invalid_token', 'この招待リンクは使えません（削除された可能性があります）');
  return me;
}

function albumRow_(albumId) {
  const album = readRows_('albums').filter(function (a) { return a.album_id === albumId; })[0];
  if (!album) throw apiError_('invalid_token', 'アルバムが見つかりません');
  return album;
}

function publicAlbum_(a) {
  return { album_id: a.album_id, name: a.name, created_at: a.created_at, icon: parseJson_(a.icon_photo, null) };
}

function publicMember_(m) {
  return { member_id: m.member_id, display_name: m.display_name, joined: !!m.joined_at };
}

function publicCatch_(c) {
  return {
    catch_id: c.catch_id,
    caught_at: c.caught_at,
    lat: Number(c.lat),
    lng: Number(c.lng),
    place_name: c.place_name,
    species: c.species,
    size_cm: c.size_cm === '' ? null : Number(c.size_cm),
    weight_g: c.weight_g === '' ? null : Number(c.weight_g),
    count: Number(c.count) || 1,
    angler_member_id: c.angler_member_id,
    tide_name: c.tide_name,
    tide_events: parseJson_(c.tide_events, null),
    method: c.method,
    bait: c.bait,
    memo: c.memo,
    photo_ids: parseJson_(c.photo_ids, []),
    hits: parseJson_(c.hits, null),
    created_by: c.created_by,
    created_at: c.created_at,
    updated_by: c.updated_by,
    updated_at: c.updated_at
  };
}

function text_(v, max, label, required) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (required && !s) throw apiError_('invalid', label + 'を入力してください');
  if (s.length > max) throw apiError_('invalid', label + 'は' + max + '文字以内にしてください');
  return s;
}

function num_(v, min, max, label, required) {
  if (v === undefined || v === null || v === '') {
    if (required) throw apiError_('invalid', label + 'を入力してください');
    return '';
  }
  const n = Number(v);
  if (!isFinite(n) || n < min || n > max) throw apiError_('invalid', label + 'の値が正しくありません');
  return n;
}

function parseJson_(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function validToken_(t) {
  return typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);
}

function validFileId_(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{10,100}$/.test(id);
}

// 推測できないランダムな64文字（UUID 2つ分）
function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
}

function now_() {
  return new Date().toISOString();
}
