// 地図（Leaflet）。レイヤー切替・現在地・ピン表示・ピン指定。

const L = window.L;

export const LAYERS = {
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  },
  gsi: {
    name: '地理院 標準',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>'
  },
  photo: {
    name: '地理院 航空写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>' +
      '｜データソース：Landsat8画像（GSI,TSIC,GEO Grid/AIST）、GRUS画像（&copy; Axelspace）'
  }
};

const JAPAN = { center: [36.2, 138.3], zoom: 5 };
const PIN_COLORS = ['#e4572e', '#2e86de', '#20a464', '#a55eea', '#f0932b'];

export function mapReady() {
  return !!L;
}

function baseMap(el, layerKey, { layerControl = true, ...options } = {}) {
  const map = L.map(el, { zoomControl: true, attributionControl: true, ...options });
  const layers = {};
  Object.entries(LAYERS).forEach(([key, def]) => {
    layers[def.name] = L.tileLayer(def.url, { attribution: def.attribution, maxZoom: 19, maxNativeZoom: 18 });
    if (key === (LAYERS[layerKey] ? layerKey : 'osm')) layers[def.name].addTo(map);
  });
  if (layerControl) L.control.layers(layers, null, { position: 'topright' }).addTo(map);
  map.attributionControl.setPrefix(false);
  return map;
}

export function pinIcon(colorIndex = 0, extraClass = '') {
  const color = PIN_COLORS[colorIndex % PIN_COLORS.length];
  return L.divIcon({
    className: 'pin ' + extraClass,
    html: `<span style="background:${color}"></span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 26],
    popupAnchor: [0, -24]
  });
}

// 現在地（Promise）。maxAge：これより新しい控えがあればそれを使う（ms）
export function getCurrentPosition({ maxAge = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('この端末では現在地を取得できません'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      err => reject(new Error(err.code === 1 ? '位置情報の利用が許可されていません（端末の設定を確認してください）' : '現在地を取得できませんでした')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: maxAge }
    );
  });
}

function addLocateButton(map, onError) {
  let here = null;
  const Control = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'map-btn');
      btn.type = 'button';
      btn.title = '現在地';
      btn.setAttribute('aria-label', '現在地');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', async () => {
        btn.classList.add('busy');
        try {
          const p = await getCurrentPosition();
          if (here) here.remove();
          here = L.circleMarker([p.lat, p.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 }).addTo(map);
          map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15));
        } catch (e) {
          onError(e.message);
        } finally {
          btn.classList.remove('busy');
        }
      });
      return btn;
    }
  });
  new Control().addTo(map);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 画面に触れている指の数（長押しのあと、指を離すのを待つため）
let touchCount = 0;
['touchstart', 'touchend', 'touchcancel'].forEach(ev => document.addEventListener(ev, e => { touchCount = e.touches.length; }, { capture: true, passive: true }));

// すべての指が離れたら（または maxMs 経ったら）終わる
function fingerUp(maxMs) {
  if (!touchCount) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      document.removeEventListener('touchend', check, true);
      document.removeEventListener('touchcancel', check, true);
      resolve();
    };
    const check = e => { if (!e.touches.length) done(); };
    const timer = setTimeout(done, maxMs);
    document.addEventListener('touchend', check, true);
    document.addEventListener('touchcancel', check, true);
  });
}

// 地図の右上に置く文字ボタン（例：「ルート」）
function addTextButton(map, label, onClick) {
  const Control = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'map-btn map-text-btn');
      btn.type = 'button';
      btn.textContent = label;
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', onClick);
      return btn;
    }
  });
  new Control().addTo(map);
}

export const ROUTE_COLORS = ['#e4572e', '#2e86de', '#20a464', '#a55eea', '#f0932b', '#d6336c'];
const ROUTE_MAX_ZOOM = 17; // ほとんど動かない釣行でも、寄りすぎて周りが見えなくならないように

// アルバムの地図。釣果をピン（近いものはまとめて）表示し、長押しで onLongPress を呼ぶ。
// 釣行のルートを線で表示できる（setRoutes）。onRouteButton があれば右上に「ルート」ボタンを置く
export function createCatchMap(el, { layerKey, catches, colorOf, popupHtml, onLongPress, onError, view, onRouteButton }) {
  const map = baseMap(el, layerKey);
  addLocateButton(map, onError);
  if (onRouteButton) addTextButton(map, 'ルート', onRouteButton);
  const routeLayer = L.layerGroup().addTo(map);
  const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 50 });
  map.addLayer(cluster);

  function setCatches(list, fit) {
    cluster.clearLayers();
    const points = [];
    list.forEach(c => {
      if (!isFinite(c.lat) || !isFinite(c.lng)) return;
      const marker = L.marker([c.lat, c.lng], { icon: pinIcon(colorOf(c), c._pending ? 'pending' : c.draft ? 'draft' : '') });
      marker.bindPopup(() => popupHtml(c), { minWidth: 180, maxWidth: 240 });
      cluster.addLayer(marker);
      points.push([c.lat, c.lng]);
    });
    if (fit) {
      if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
      else map.setView(JAPAN.center, JAPAN.zoom);
    }
  }

  if (view) map.setView(view.center, view.zoom);
  setCatches(catches, !view);

  // 長押し：押した場所に波紋とピンを出し、指を離してから（最大1.2秒）次の画面へ
  let pressing = false;
  map.on('contextmenu', e => {
    if (pressing) return;
    pressing = true;
    L.marker(e.latlng, { icon: L.divIcon({ className: 'press-ripple', iconSize: [90, 90] }), interactive: false, keyboard: false }).addTo(map);
    L.marker(e.latlng, { icon: pinIcon(0, 'drop'), interactive: false, keyboard: false }).addTo(map);
    if (navigator.vibrate) navigator.vibrate(12);
    Promise.all([delay(320), fingerUp(1200)]).then(() => onLongPress(e.latlng, { touching: touchCount > 0 }));
  });
  // routes：[{ id, color, latlngs: [[lat, lng], …] }]。始点は○、終点は■
  function setRoutes(routes) {
    routeLayer.clearLayers();
    routes.forEach(r => {
      if (!r.latlngs.length) return;
      L.polyline(r.latlngs, { color: r.color, weight: 4, opacity: 0.85, dashArray: r.latlngs.length > 1 ? null : '1' }).addTo(routeLayer);
      L.circleMarker(r.latlngs[0], { radius: 6, color: '#fff', weight: 2, fillColor: r.color, fillOpacity: 1 }).addTo(routeLayer);
      if (r.latlngs.length > 1) {
        const end = r.latlngs[r.latlngs.length - 1];
        L.marker(end, { icon: L.divIcon({ className: 'route-end', html: `<span style="background:${r.color}"></span>`, iconSize: [14, 14] }), interactive: false }).addTo(routeLayer);
      }
    });
  }

  // その範囲が全部入るように倍率を合わせる（大きく動いた釣行は引いて、ほとんど動かない釣行は寄る。寄りすぎない）
  function fitTo(latlngs) {
    if (!latlngs.length) return;
    map.fitBounds(L.latLngBounds(latlngs), { padding: [48, 48], maxZoom: ROUTE_MAX_ZOOM });
  }

  return {
    map,
    setRoutes,
    fitTo,
    setCatches: list => setCatches(list, false),
    getView: () => ({ center: map.getCenter(), zoom: map.getZoom() }),
    remove: () => map.remove()
  };
}

// 登録画面の地図。タップした場所・ドラッグした場所に位置を合わせる
export function createPickerMap(el, { layerKey, value, fallbackCenter, onChange }) {
  const map = baseMap(el, layerKey, { tap: true });
  let marker = null;

  function place(latlng, notify) {
    if (!marker) {
      marker = L.marker(latlng, { icon: pinIcon(0), draggable: true, autoPan: true }).addTo(map);
      marker.on('dragend', () => onChange(marker.getLatLng()));
    } else {
      marker.setLatLng(latlng);
    }
    if (notify) onChange(L.latLng(latlng));
  }

  if (value) {
    place([value.lat, value.lng], false);
    map.setView([value.lat, value.lng], 15);
  } else if (fallbackCenter) {
    map.setView([fallbackCenter.lat, fallbackCenter.lng], 12);
  } else {
    map.setView(JAPAN.center, JAPAN.zoom);
  }
  map.on('click', e => place(e.latlng, true));
  return {
    set(v) {
      place([v.lat, v.lng], false);
      map.setView([v.lat, v.lng], Math.max(map.getZoom(), 15));
    },
    invalidate: () => map.invalidateSize(),
    remove: () => map.remove()
  };
}

// 詳細画面の小さい地図
export function createMiniMap(el, { layerKey, lat, lng }) {
  const map = baseMap(el, layerKey, { layerControl: false, scrollWheelZoom: false, dragging: !L.Browser.mobile, zoomControl: false });
  L.marker([lat, lng], { icon: pinIcon(0) }).addTo(map);
  map.setView([lat, lng], 14);
  return { remove: () => map.remove() };
}
