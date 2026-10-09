// 各 API の中身。createAlbum・getInvite 以外は、毎回トークンを確認し、
// そのトークンが属するアルバムのデータだけを扱う。

const MAX_ALBUMS_PER_DAY = 20; // アプリ全体で1日に作れるアルバム数（乱用対策）
const MAX_PHOTOS = 5;        // 1回（釣れた回）あたりの写真の枚数
const MAX_PHOTOS_TOTAL = 50; // 1件の釣果の写真の合計
const MAX_HITS = 50; // 1件の釣果に入れられる「釣れた回」の数
const TIDE_NAMES = ['', '大潮', '中潮', '小潮', '長潮', '若潮'];
const LOC_SOURCES = ['', 'button', 'estimated', 'manual']; // 位置の出どころ：「釣れた！」／撮影時刻から推定／手動
const POINT_KINDS = ['start', 'open', 'hit', 'catch', 'end'];
const MAX_TRIP_POINTS = 500;
const MAX_TRIP_DRAFTS = 50;
const TRIP_MAX_MS = 12 * 60 * 60 * 1000; // 終了し忘れた釣行は12時間で打ち切り
const TRIP_SLACK_MS = 60 * 1000;          // 釣果の時刻は分までなので、開始・終了の前後1分もその釣行とみなす
const MAX_MEMBERS = 20;       // 1つのアルバムのメンバー（招待中を含む）の上限

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

// 友達を追加で招待する：新しいメンバー（未参加）とその招待リンク用のトークンを作る。
// 参加済みのメンバーだけができる。作れるのは自分のアルバムのメンバーだけ
function apiCreateInvite_(req) {
  const name = text_(req.display_name, 30, '友達の名前', false);
  return withLock_(function () {
    const me = auth_(req.token);
    if (!me.joined_at) throw apiError_('forbidden', 'アルバムに参加してから招待してください');
    const count = readRows_('members').filter(function (m) { return m.album_id === me.album_id; }).length;
    if (count >= MAX_MEMBERS) throw apiError_('invalid', 'このアルバムにはこれ以上招待できません（' + MAX_MEMBERS + '人まで）');
    const friend = { member_id: Utilities.getUuid(), album_id: me.album_id, display_name: name, token: newToken_(), joined_at: '' };
    appendRow_('members', friend);
    return {
      invite: { member_id: friend.member_id, token: friend.token, display_name: name },
      member: publicMember_(friend)
    };
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
    trips: readRows_('trips').filter(function (t) {
      return t.album_id === album.album_id && t.deleted !== 'true';
    }).map(publicTrip_),
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
    const has = function (k) { return Object.prototype.hasOwnProperty.call(input, k); };

    if (!input.catch_id) {
      // client_id：画面が作った ID。送り直し（電波が切れて届いたか分からなかったとき）で二重に登録しない
      const clientId = input.client_id ? validId_(input.client_id, '釣果') : '';
      if (clientId) {
        const dup = readRows_('catches').filter(function (c) { return c.catch_id === clientId; })[0];
        if (dup) {
          if (dup.album_id !== me.album_id) throw apiError_('forbidden', 'この釣果は登録できません');
          if (dup.draft !== 'true') return { catch: publicCatch_(dup) };
          // 「釣れた！」の下書きが先に届いていたら、その下書きを今回の内容で埋める
          const tripId = dup.trip_id;
          Object.assign(dup, fields, { updated_by: me.member_id, updated_at: now });
          dup.trip_id = fields.trip_id || tripId;
          updateRow_('catches', dup._row, dup);
          return { catch: publicCatch_(dup) };
        }
      }
      if (!has('loc_source')) fields.loc_source = '';
      fields.trip_id = fields.trip_id || findTripId_(me.album_id, fields, me.member_id);
      const row = Object.assign({
        catch_id: clientId || Utilities.getUuid(),
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
    if (!has('loc_source')) delete fields.loc_source; // 古い画面は送らないので、今の値を残す
    fields.trip_id = fields.trip_id || findTripId_(me.album_id, fields, row.created_by);
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
  const draft = c.draft === true;
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
  if (photos.length > MAX_PHOTOS_TOTAL) throw apiError_('invalid', '写真は合計' + MAX_PHOTOS_TOTAL + '枚までです');
  let cleanPhotos = cleanPhotoList_(photos);
  let count = num_(c.count, 1, 9999, '匹数', true);
  if (Math.floor(count) !== count) throw apiError_('invalid', '匹数は整数で入力してください');
  // 釣れた回。時刻順に並べ、日時＝最初の回、匹数＝合計にそろえる
  const hits = cleanHits_(c.hits, members);
  const summary = hitSummary_(hits);
  if (hits.length) {
    caughtAt = hits[0].at;
    count = hits.reduce(function (sum, h) { return sum + h.count; }, 0);
    // 回ごとに写真が付いていれば、釣果の写真＝各回の写真を時刻順につなげたもの
    if (hits.some(function (h) { return h.photos; })) {
      cleanPhotos = [].concat.apply([], hits.map(function (h) { return h.photos || []; }));
      if (cleanPhotos.length > MAX_PHOTOS_TOTAL) throw apiError_('invalid', '写真は合計' + MAX_PHOTOS_TOTAL + '枚までです');
    }
  }
  const fields = {
    caught_at: caughtAt,
    lat: lat,
    lng: lng,
    place_name: text_(c.place_name, 100, '場所名', false),
    species: text_(c.species, 50, '魚種', !draft),
    size_cm: num_(c.size_cm, 0, 1000, 'サイズ', false),
    weight_g: num_(c.weight_g, 0, 1000000, '重さ', false),
    count: count,
    angler_member_id: angler,
    tide_name: tide,
    method: text_(c.method, 100, '釣り方・仕掛け', false),
    bait: text_(c.bait, 100, 'エサ／ルアー', false),
    memo: text_(c.memo, 2000, 'メモ', false),
    photo_ids: JSON.stringify(cleanPhotos),
    hits: hits.length > 1 ? JSON.stringify(hits) : '',
    trip_id: c.trip_id ? validId_(c.trip_id, '釣行') : '',
    loc_source: cleanLocSource_(c.loc_source),
    draft: draft ? 'true' : 'false'
  };
  // 回ごとに魚種などが入っていれば、釣果全体の値は回からまとめたものにする（画面の summarizeHits と同じ決め方）
  return summary ? Object.assign(fields, summary) : fields;
}

// 魚種＝重ならないように「・」でつなぐ、サイズ・重さ＝最大、釣った人・潮・タックル・メモ＝最初の回
function hitSummary_(hits) {
  if (!hits.length || hits[0].species === undefined) return null;
  const max = function (key) {
    const v = hits.map(function (h) { return h[key]; }).filter(function (x) { return x !== ''; });
    return v.length ? Math.max.apply(null, v) : '';
  };
  const species = [];
  hits.forEach(function (h) { if (species.indexOf(h.species) < 0) species.push(h.species); });
  const first = hits[0];
  return {
    species: species.join('・').slice(0, 50),
    size_cm: max('size_cm'),
    weight_g: max('weight_g'),
    angler_member_id: first.angler_member_id,
    tide_name: first.tide_name,
    method: first.method,
    bait: first.bait,
    memo: first.memo
  };
}

function cleanLocSource_(v) {
  const s = v === undefined || v === null ? '' : String(v);
  if (LOC_SOURCES.indexOf(s) < 0) throw apiError_('invalid', '位置の出どころの値が正しくありません');
  return s;
}

// 写真：Drive のファイルID（原寸 f・サムネ t）と、撮影時刻 at（任意。潮位グラフの範囲に使う。位置は持たない）
function cleanPhotoList_(list) {
  return list.map(function (p) {
    if (!p || !validFileId_(p.f) || !validFileId_(p.t)) throw apiError_('invalid', '写真の情報が正しくありません');
    const photo = { f: p.f, t: p.t };
    if (p.at) photo.at = dateText_(p.at, '撮影時刻');
    return photo;
  });
}

// 回ごとの魚種・サイズ・釣った人・潮・タックル・メモは、送られてきたときだけ確かめて入れる（古い画面は送らない）
function cleanHits_(list, members) {
  if (!Array.isArray(list)) return [];
  const full = list.some(function (h) { return h && h.species !== undefined; });
  if (list.length > MAX_HITS) throw apiError_('invalid', '釣れた回は' + MAX_HITS + '回までです');
  const hits = list.map(function (h) {
    const at = text_(h && h.at, 40, '釣れた時刻', true);
    if (isNaN(Date.parse(at))) throw apiError_('invalid', '釣れた時刻の形式が正しくありません');
    const count = num_(h.count, 1, 9999, '匹数', true);
    if (Math.floor(count) !== count) throw apiError_('invalid', '匹数は整数で入力してください');
    const hit = { at: at, count: count };
    if (full) {
      hit.species = text_(h.species, 50, '魚種', true);
      hit.size_cm = num_(h.size_cm, 0, 1000, 'サイズ', false);
      hit.weight_g = num_(h.weight_g, 0, 1000000, '重さ', false);
      hit.angler_member_id = text_(h.angler_member_id, 60, '釣った人', true);
      if (!members.some(function (m) { return m.member_id === hit.angler_member_id; })) {
        throw apiError_('invalid', '釣った人がアルバムのメンバーではありません');
      }
      hit.tide_name = text_(h.tide_name, 10, '潮', false);
      if (TIDE_NAMES.indexOf(hit.tide_name) < 0) throw apiError_('invalid', '潮の値が正しくありません');
      hit.method = text_(h.method, 100, '釣り方・仕掛け', false);
      hit.bait = text_(h.bait, 100, 'エサ／ルアー', false);
      hit.memo = text_(h.memo, 2000, 'メモ', false);
    }
    if (Array.isArray(h.photos)) {
      if (h.photos.length > MAX_PHOTOS) throw apiError_('invalid', '写真は1回につき' + MAX_PHOTOS + '枚までです');
      hit.photos = cleanPhotoList_(h.photos);
    }
    return hit;
  });
  hits.sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
  return hits;
}

// ---------- 釣行 ----------
// 釣行の記録は端末にため、終了時にまとめて送られてくる。trip_id・下書きの catch_id は端末で作るので、
// 同じ釣行を2回送っても重複しない（上書き・既にある下書きは作らない）。

function apiSaveTrip_(req) {
  const t = req.trip || {};
  const tripId = validId_(t.trip_id, '釣行');
  const startedAt = dateText_(t.started_at, '開始時刻');
  const endedAt = dateText_(t.ended_at, '終了時刻');
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw apiError_('invalid', '終了時刻が開始時刻より前です');
  const points = cleanPoints_(t.points);
  const drafts = Array.isArray(req.drafts) ? req.drafts : [];
  if (drafts.length > MAX_TRIP_DRAFTS) throw apiError_('invalid', '下書きは' + MAX_TRIP_DRAFTS + '件までです');

  return withLock_(function () {
    const me = auth_(req.token);
    const now = now_();
    const start = points.filter(function (p) { return p.kind === 'start'; })[0];
    const end = points.filter(function (p) { return p.kind === 'end'; }).pop();
    const fields = {
      trip_id: tripId,
      album_id: me.album_id,
      member_id: me.member_id,
      started_at: startedAt,
      ended_at: endedAt,
      start_lat: start ? start.lat : '',
      start_lng: start ? start.lng : '',
      end_lat: end ? end.lat : '',
      end_lng: end ? end.lng : '',
      points: JSON.stringify(points),
      auto_ended: t.auto_ended === true ? 'true' : 'false',
      updated_at: now,
      deleted: 'false'
    };
    const existing = readRows_('trips').filter(function (x) { return x.trip_id === tripId; })[0];
    let row;
    if (existing) {
      if (existing.album_id !== me.album_id || existing.member_id !== me.member_id) throw apiError_('forbidden', 'この釣行は変更できません');
      row = Object.assign(existing, fields);
      updateRow_('trips', row._row, row);
    } else {
      row = Object.assign({ created_at: now }, fields);
      appendRow_('trips', row);
    }

    // 「釣れた！」の下書き（時刻と位置だけ）
    const catches = readRows_('catches');
    drafts.forEach(function (d) {
      const id = validId_(d.draft_id, '下書き');
      if (catches.some(function (c) { return c.catch_id === id; })) return;
      const at = dateText_(d.caught_at, '下書きの時刻');
      const draft = {
        catch_id: id, album_id: me.album_id, caught_at: at,
        lat: num_(d.lat, -90, 90, '緯度', true), lng: num_(d.lng, -180, 180, '経度', true),
        place_name: '', species: '', size_cm: '', weight_g: '', count: 1, angler_member_id: me.member_id,
        tide_name: '', tide_events: '', method: '', bait: '', memo: '', photo_ids: '[]', hits: '',
        trip_id: tripId, loc_source: 'button', draft: 'true',
        created_by: me.member_id, created_at: now, updated_by: me.member_id, updated_at: now, deleted: 'false'
      };
      appendRow_('catches', draft);
      catches.push(draft);
    });

    // 釣行中の時刻の釣果（自分が釣った・登録した、まだどの釣行にもひも付いていないもの）をひも付ける
    catches.forEach(function (c) {
      if (!c._row || c.album_id !== me.album_id || c.deleted === 'true' || c.trip_id) return;
      if (c.angler_member_id !== me.member_id && c.created_by !== me.member_id) return;
      const at = Date.parse(c.caught_at);
      if (at >= Date.parse(startedAt) - TRIP_SLACK_MS && at <= Date.parse(endedAt) + TRIP_SLACK_MS) {
        c.trip_id = tripId;
        updateRow_('catches', c._row, c);
      }
    });
    return { trip: publicTrip_(row) };
  });
}

function apiDeleteTrip_(req) {
  const tripId = validId_(req.trip_id, '釣行');
  return withLock_(function () {
    const me = auth_(req.token);
    const row = readRows_('trips').filter(function (x) {
      return x.trip_id === tripId && x.album_id === me.album_id && x.deleted !== 'true';
    })[0];
    if (!row) throw apiError_('not_found', 'この釣行は見つかりません');
    if (row.member_id !== me.member_id) throw apiError_('forbidden', '自分の釣行だけ削除できます');
    Object.assign(row, { deleted: 'true', updated_at: now_() });
    updateRow_('trips', row._row, row);
    readRows_('catches').forEach(function (c) {
      if (c.trip_id === tripId && c.album_id === me.album_id) {
        c.trip_id = '';
        updateRow_('catches', c._row, c);
      }
    });
    return { trip_id: tripId };
  });
}

// 釣った時刻が入る釣行（釣った人か登録した人の釣行）。無ければ空
function findTripId_(albumId, fields, creatorId) {
  const at = Date.parse(fields.caught_at);
  const trip = readRows_('trips').filter(function (t) {
    if (t.album_id !== albumId || t.deleted === 'true') return false;
    if (t.member_id !== fields.angler_member_id && t.member_id !== creatorId) return false;
    const end = t.ended_at ? Date.parse(t.ended_at) : Date.parse(t.started_at) + TRIP_MAX_MS;
    return at >= Date.parse(t.started_at) - TRIP_SLACK_MS && at <= end + TRIP_SLACK_MS;
  })[0];
  return trip ? trip.trip_id : '';
}

function cleanPoints_(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > MAX_TRIP_POINTS) throw apiError_('invalid', '記録地点は' + MAX_TRIP_POINTS + 'か所までです');
  return list.map(function (p) {
    const kind = text_(p && p.kind, 10, '記録の種類', true);
    if (POINT_KINDS.indexOf(kind) < 0) throw apiError_('invalid', '記録の種類が正しくありません');
    return {
      t: dateText_(p.t, '記録時刻'),
      lat: num_(p.lat, -90, 90, '緯度', true),
      lng: num_(p.lng, -180, 180, '経度', true),
      acc: num_(p.acc, 0, 100000, '精度', false),
      kind: kind
    };
  });
}

function publicTrip_(t) {
  const n = function (v) { return v === '' ? null : Number(v); };
  return {
    trip_id: t.trip_id,
    member_id: t.member_id,
    started_at: t.started_at,
    ended_at: t.ended_at,
    start_lat: n(t.start_lat), start_lng: n(t.start_lng),
    end_lat: n(t.end_lat), end_lng: n(t.end_lng),
    points: parseJson_(t.points, []),
    auto_ended: t.auto_ended === 'true'
  };
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
    trip_id: c.trip_id || '',
    loc_source: c.loc_source || '',
    draft: c.draft === 'true',
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

// 端末や GAS で作った UUID
function validId_(v, label) {
  const s = String(v || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) throw apiError_('invalid', label + 'のIDが正しくありません');
  return s;
}

function dateText_(v, label) {
  const s = text_(v, 40, label, true);
  if (isNaN(Date.parse(s))) throw apiError_('invalid', label + 'の形式が正しくありません');
  return s;
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
