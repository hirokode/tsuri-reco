// スプレッドシートと Drive フォルダの準備・読み書き。
// スプシとフォルダは初回に自動で作り、IDをスクリプトプロパティに保存する。

// 列を増やすときは、ここの末尾に足す（既存の列の順番は変えない）。
// 既存シートの見出し行には、ensureSheet_ が足りない列を末尾に自動で追加する。
const SCHEMA = {
  albums: ['album_id', 'name', 'created_at', 'drive_folder_id', 'icon_photo'],
  members: ['member_id', 'album_id', 'display_name', 'token', 'joined_at'],
  catches: ['catch_id', 'album_id', 'caught_at', 'lat', 'lng', 'place_name', 'species', 'size_cm', 'weight_g', 'count',
    'angler_member_id', 'tide_name', 'tide_events', 'method', 'bait', 'memo', 'photo_ids',
    'created_by', 'created_at', 'updated_by', 'updated_at', 'deleted', 'hits']
};
const ROOT_FOLDER_NAME = 'Tsuri Reco';
const SPREADSHEET_NAME = 'Tsuri Reco データ';

let lockDepth_ = 0;
let ss_ = null;
const sheets_ = {};

function props_() {
  return PropertiesService.getScriptProperties();
}

// 書き込みは1件ずつ順番に処理する（同時に書いて行が壊れないように）
function withLock_(fn) {
  if (lockDepth_ > 0) return fn();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw apiError_('busy', '混み合っています。少し待ってからもう一度試してください');
  lockDepth_++;
  try {
    return fn();
  } finally {
    lockDepth_--;
    lock.releaseLock();
  }
}

// ID が保存済みなのに開けないときは、新しく作らずにエラーにする（データを見失わないため）
function getRootFolder_() {
  const id = props_().getProperty('ROOT_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  return withLock_(function () {
    const id2 = props_().getProperty('ROOT_FOLDER_ID');
    if (id2) return DriveApp.getFolderById(id2);
    const folder = DriveApp.createFolder(ROOT_FOLDER_NAME);
    props_().setProperty('ROOT_FOLDER_ID', folder.getId());
    return folder;
  });
}

function getSs_() {
  if (ss_) return ss_;
  const id = props_().getProperty('SPREADSHEET_ID');
  if (id) {
    ss_ = SpreadsheetApp.openById(id);
    return ss_;
  }
  return withLock_(function () {
    const id2 = props_().getProperty('SPREADSHEET_ID');
    if (id2) {
      ss_ = SpreadsheetApp.openById(id2);
      return ss_;
    }
    const ss = SpreadsheetApp.create(SPREADSHEET_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(getRootFolder_());
    Object.keys(SCHEMA).forEach(function (name) { ensureSheet_(ss, name); });
    ss.getSheets().forEach(function (sh) {
      if (!SCHEMA[sh.getName()]) ss.deleteSheet(sh);
    });
    props_().setProperty('SPREADSHEET_ID', ss.getId());
    ss_ = ss;
    return ss;
  });
}

// シートが無ければ作り、見出し行に足りない列があれば末尾に足す
function ensureSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.setFrozenRows(1);
  }
  const cols = SCHEMA[name];
  const lastCol = sh.getLastColumn();
  const header = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];
  const missing = cols.filter(function (c) { return header.indexOf(c) < 0; });
  if (missing.length) {
    const start = header.filter(String).length + 1;
    sh.getRange(1, start, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function sheet_(name) {
  if (!sheets_[name]) sheets_[name] = ensureSheet_(getSs_(), name);
  return sheets_[name];
}

function header_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
}

// シートの全行をオブジェクトの配列で返す。_row はシート上の行番号
function readRows_(name) {
  const sh = sheet_(name);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(1, 1, lastRow, sh.getLastColumn()).getDisplayValues();
  const header = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const obj = { _row: i + 1 };
    header.forEach(function (h, j) { if (h) obj[h] = values[i][j]; });
    rows.push(obj);
  }
  return rows;
}

// 「=」で始まる文字は、書式がテキストでも数式として計算されてしまうので、先頭に ' を付けて文字として保存する
// （' はセルの中身には残らず、読み出すときは元の文字に戻る）
function toValues_(header, obj) {
  return header.map(function (h) {
    const v = obj[h];
    const s = v === undefined || v === null ? '' : String(v);
    return s.charAt(0) === '=' ? "'" + s : s;
  });
}

// 書式を「テキスト」にしてから書く（日時やトークンが勝手に変換されないように）
function appendRow_(name, obj) {
  const sh = sheet_(name);
  const header = header_(sh);
  const range = sh.getRange(sh.getLastRow() + 1, 1, 1, header.length);
  range.setNumberFormat('@').setValues([toValues_(header, obj)]);
}

function updateRow_(name, rowNum, obj) {
  const sh = sheet_(name);
  const header = header_(sh);
  const range = sh.getRange(rowNum, 1, 1, header.length);
  range.setNumberFormat('@').setValues([toValues_(header, obj)]);
}
