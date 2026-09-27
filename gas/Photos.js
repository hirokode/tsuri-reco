// 写真の保存。画面で圧縮済みの JPEG（原寸1600px・サムネ400px）を base64 で受け取り、
// アルバムの Drive フォルダに保存して「リンクを知っている人は閲覧可」にする。
// 位置情報などを残さないため、保存前に EXIF などのメタデータ部分を必ず取り除く。

const MAX_FULL_BYTES = 4 * 1024 * 1024;
const MAX_THUMB_BYTES = 1024 * 1024;

function apiUploadPhoto_(req) {
  const me = auth_(req.token);
  const full = decodeJpeg_(req.full, MAX_FULL_BYTES);
  const thumb = decodeJpeg_(req.thumb, MAX_THUMB_BYTES);
  const folder = albumFolder_(me.album_id);
  const base = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '_' + Utilities.getUuid().slice(0, 8);
  const f = saveJpeg_(folder, full, base + '.jpg');
  const t = saveJpeg_(folder, thumb, base + '_t.jpg');
  return { photo: { f: f, t: t } };
}

function saveJpeg_(folder, bytes, name) {
  const file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getId();
}

// アルバムのフォルダ。手で消されていたら作り直す
function albumFolder_(albumId) {
  const album = albumRow_(albumId);
  if (album.drive_folder_id) {
    try {
      const folder = DriveApp.getFolderById(album.drive_folder_id);
      if (!folder.isTrashed()) return folder;
    } catch (e) {
      // 見つからないときは下で作り直す
    }
  }
  return withLock_(function () {
    const fresh = albumRow_(albumId);
    const folder = getRootFolder_().createFolder(fresh.name + ' (' + albumId.slice(0, 8) + ')');
    fresh.drive_folder_id = folder.getId();
    updateRow_('albums', fresh._row, fresh);
    return folder;
  });
}

function decodeJpeg_(b64, maxBytes) {
  if (typeof b64 !== 'string' || !b64) throw apiError_('invalid', '写真のデータがありません');
  if (b64.length > Math.ceil(maxBytes / 3) * 4 + 4) throw apiError_('invalid', '写真のサイズが大きすぎます');
  let bytes;
  try {
    bytes = Utilities.base64Decode(b64);
  } catch (e) {
    throw apiError_('invalid', '写真のデータが壊れています');
  }
  return stripJpegMetadata_(bytes);
}

// JPEG から APP0（JFIF）と APP2（色の情報）以外の APP 領域とコメントを取り除く。
// APP1 が EXIF（撮影位置など）・XMP、APP13 が IPTC にあたる。
// Apps Script のバイト配列は -128〜127 なので & 0xff で読む。
function stripJpegMetadata_(bytes) {
  const b = function (i) { return bytes[i] & 0xff; };
  if (bytes.length < 4 || b(0) !== 0xff || b(1) !== 0xd8) throw apiError_('invalid', 'JPEG 形式の写真ではありません');
  const out = [bytes.slice(0, 2)];
  let i = 2;
  while (i < bytes.length) {
    if (b(i) !== 0xff) throw apiError_('invalid', '写真のデータが壊れています');
    const marker = b(i + 1);
    if (marker === 0xff) { i++; continue; } // 詰め物のバイト
    if (marker === 0xda || marker === 0xd9) { // 画像データの開始（以降はそのまま）／終端
      out.push(bytes.slice(i));
      break;
    }
    if (i + 3 >= bytes.length) throw apiError_('invalid', '写真のデータが壊れています');
    const len = (b(i + 2) << 8) | b(i + 3);
    const end = i + 2 + len;
    if (len < 2 || end > bytes.length) throw apiError_('invalid', '写真のデータが壊れています');
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !(isApp && marker !== 0xe0 && marker !== 0xe2) && marker !== 0xfe;
    if (keep) out.push(bytes.slice(i, end));
    i = end;
  }
  return [].concat.apply([], out);
}
