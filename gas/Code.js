// Tsuri Reco API の入口。
// 画面（GitHub Pages）から fetch の POST で {action, token, ...} が届く。
// 返り値は {ok:true, data} または {ok:false, error, message}。

const ACTIONS = {
  createAlbum: apiCreateAlbum_,
  getInvite: apiGetInvite_,
  join: apiJoin_,
  listAlbums: apiListAlbums_,
  getAlbum: apiGetAlbum_,
  saveCatch: apiSaveCatch_,
  deleteCatch: apiDeleteCatch_,
  uploadPhoto: apiUploadPhoto_,
  updateMe: apiUpdateMe_,
  updateAlbum: apiUpdateAlbum_
};

// 動作確認用。ブラウザで /exec を開くと {ok:true} が返る
function doGet() {
  return json_({ ok: true, app: 'tsuri-reco' });
}

function doPost(e) {
  let res;
  try {
    if (!e || !e.postData || !e.postData.contents) throw apiError_('bad_request', 'リクエストが空です');
    const req = JSON.parse(e.postData.contents);
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS, req.action) ? ACTIONS[req.action] : null;
    if (!fn) throw apiError_('bad_action', '不明な操作です');
    res = { ok: true, data: fn(req) };
  } catch (err) {
    if (err && err.apiCode) {
      res = { ok: false, error: err.apiCode, message: err.message, detail: err.detail || null };
    } else {
      console.error(err && err.stack ? err.stack : err);
      res = { ok: false, error: 'server', message: 'サーバーでエラーが起きました（' + (err && err.message ? err.message : err) + '）' };
    }
  }
  return json_(res);
}

// Apps Script エディタで1回だけ ▶実行する関数。
// 権限の承認ダイアログを出すのと、スプレッドシート・Driveフォルダの作成を兼ねる。
// （実行しなくても、最初のリクエストで自動作成される）
function setup() {
  const ss = getSs_();
  getRootFolder_();
  Logger.log('準備ができました。データのスプレッドシート：' + ss.getUrl());
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function apiError_(code, message, detail) {
  const err = new Error(message);
  err.apiCode = code;
  err.detail = detail;
  return err;
}
