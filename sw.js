// Service Worker：ホーム画面から起動できるようにし、写真を端末にためて2回目以降すぐ表示する。
// 画面のファイル（app.js など）を変えたら CACHE_VERSION を上げる。

const CACHE_VERSION = 'v25';
const SHELL_CACHE = 'shell-' + CACHE_VERSION;
const LIB_CACHE = 'lib-v1';   // CDN のライブラリ（バージョン固定なので変わらない）
const IMG_CACHE = 'img-v2';   // 写真（CORS で取得したもの）
const IMG_MAX = 300;          // 写真のキャッシュ上限（古いものから消す）
const TIDE_CACHE = 'tide-v1'; // 潮位表のデータ（画面の更新では消さない。電波が無くても表示できるように）

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './config.js',
  './js/app.js',
  './js/api.js',
  './js/photos.js',
  './js/map.js',
  './js/tide.js',
  './js/trip.js',
  './manifest.json',
  './icons/icon-192.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => (k.startsWith('shell-') && k !== SHELL_CACHE) || (k.startsWith('img-') && k !== IMG_CACHE))
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin && url.pathname.includes('/data/tide/')) {
    event.respondWith(networkFirst(req, TIDE_CACHE));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  } else if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(cacheFirst(req, LIB_CACHE));
  } else if (url.hostname === 'lh3.googleusercontent.com' || (url.hostname === 'drive.google.com' && url.pathname === '/thumbnail')) {
    event.respondWith(cacheFirst(req, IMG_CACHE, IMG_MAX));
  }
  // それ以外（地図のタイル・GAS など）は通常どおり通信する
});

// 画面のファイル：まず通信し、つながらなければ控えを使う（更新がすぐ反映されるように）
// GitHub Pages は10分間のブラウザキャッシュを許すので、no-cache で毎回サーバーに更新の有無を確かめる
async function networkFirst(req, cacheName = SHELL_CACHE) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req.url, { cache: 'no-cache' });
    if (res.ok) cache.put(stripQuery(req), res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(stripQuery(req)) || (req.mode === 'navigate' ? await cache.match('./') : null);
    if (hit) return hit;
    throw e;
  }
}

// 写真・ライブラリ：控えがあれば通信せずにそれを使う
async function cacheFirst(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') {
    try {
      await cache.put(req, res.clone());
      if (max) await trim(cache, max);
    } catch (e) {
      // 端末の容量不足などで保存できなくても表示は続ける
    }
  }
  return res;
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// ?invite=… などが付いていても同じ画面として控える
function stripQuery(req) {
  const url = new URL(req.url);
  url.search = '';
  return url.toString();
}
