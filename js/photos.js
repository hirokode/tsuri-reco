// 写真：撮影日時の読み取り・圧縮・表示URLの組み立て。
// 圧縮は canvas で描き直して JPEG にするため、EXIF（位置情報など）は保存用データに残らない。

export const MAX_PHOTOS = 5;
const FULL_SIDE = 1600;
const THUMB_SIDE = 400;
const ICON_SIDE = 800;
const QUALITY = 0.8;

// 写真の表示URLはこの関数だけで組み立てる（将来、保存先を移すときはここを直す）
export function photoUrl(fileId, width) {
  return `https://lh3.googleusercontent.com/d/${encodeURIComponent(fileId)}=w${width}`;
}

// 上のURLで表示できなかったときの予備
export function photoFallbackUrl(fileId, width) {
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w${width}`;
}

// <img> の HTML。読み込みに失敗したら予備のURLに切り替える（app.js の error 監視）
export function photoImg(fileId, width, className = '', alt = '') {
  // crossorigin：どちらのURLも CORS を許可しているので、Service Worker が中身の見える形でキャッシュできる
  return `<img class="${className}" src="${photoUrl(fileId, width)}" data-fallback="${photoFallbackUrl(fileId, width)}" crossorigin="anonymous" loading="lazy" decoding="async" alt="${alt}">`;
}

// 撮影日時（EXIF）。読めなければ null。位置情報は読まない
export async function readTakenAt(file) {
  try {
    if (!window.exifr) return null;
    // exif の中の日時だけを読む（lite 版では pick 指定が使えないため、この書き方にする）
    const exif = await window.exifr.parse(file, { ifd0: false, exif: ['DateTimeOriginal', 'CreateDate'], gps: false, ifd1: false, interop: false });
    const d = exif && (exif.DateTimeOriginal || exif.CreateDate);
    return d instanceof Date && !isNaN(d) ? d : null;
  } catch (e) {
    return null;
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('この写真の形式は読み込めません')); };
    img.src = url;
  });
}

function resize(img, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('写真の圧縮に失敗しました'))), 'image/jpeg', QUALITY);
  });
}

// 選んだ写真1枚から、撮影日時・原寸（1600px）・サムネ（400px）を作る
export async function preparePhoto(file) {
  const takenAt = await readTakenAt(file);
  const img = await loadImage(file);
  const full = await resize(img, FULL_SIDE);
  const thumb = await resize(img, THUMB_SIDE);
  return { takenAt, full, thumb, previewUrl: URL.createObjectURL(thumb) };
}

// 中央を正方形に切り抜いて side×side の JPEG にする（アルバムのアイコン用）
function cropSquare(img, side) {
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  const out = Math.max(1, Math.min(side, s));
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, out, out);
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('画像の圧縮に失敗しました'))), 'image/jpeg', QUALITY);
  });
}

// アルバムのアイコン画像：正方形に切り抜いた原寸（800px）・サムネ（400px）を作る
export async function prepareIcon(file) {
  const img = await loadImage(file);
  const full = await cropSquare(img, ICON_SIDE);
  const thumb = await cropSquare(img, THUMB_SIDE);
  return { full, thumb, previewUrl: URL.createObjectURL(thumb) };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('写真の読み込みに失敗しました'));
    reader.readAsDataURL(blob);
  });
}
