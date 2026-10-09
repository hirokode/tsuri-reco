// 送信待ちの釣果（新規登録で、まだサーバーに届いていないもの）を写真の Blob ごと IndexedDB に控える。
// アプリを閉じたり、送信中に画面を切り替えて止まったりしても消えず、次に開いたとき・電波が戻ったときに送り直す。
// IndexedDB が使えない端末（プライベートブラウズなど）では、これまでどおりメモリだけで続ける。

const DB_NAME = 'tr-pending';
const STORE = 'catches';

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'catch_id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(e => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// 画面だけで使う値（状態・プレビューURL）は控えない。写真は Blob のまま入れられる
function toRecord(albumId, p) {
  const { _pending, _error, _previews, _photos, ...rest } = p;
  const photos = (_photos || []).map(({ previewUrl, ...x }) => x);
  return { ...rest, _albumId: albumId, _photos: photos };
}

export async function savePending(albumId, p) {
  try {
    await run('readwrite', s => s.put(toRecord(albumId, p)));
  } catch (e) {
    console.warn('送信待ちを端末に控えられませんでした', e);
  }
}

export async function deletePending(catchId) {
  try {
    await run('readwrite', s => s.delete(catchId));
  } catch (e) {
    console.warn('送信待ちの控えを消せませんでした', e);
  }
}

// 控えてある送信待ちを、アルバムIDごとに返す。プレビューURLは作り直す
export async function loadPending() {
  let list = [];
  try {
    list = (await run('readonly', s => s.getAll())) || [];
  } catch (e) {
    return [];
  }
  return list.map(({ _albumId, ...p }) => {
    const photos = (p._photos || []).map(x => (x.kind === 'new' && x.thumb ? { ...x, previewUrl: URL.createObjectURL(x.thumb) } : x));
    return { albumId: _albumId, p: { ...p, _photos: photos, _previews: photos.filter(x => x.previewUrl).map(x => x.previewUrl) } };
  });
}
