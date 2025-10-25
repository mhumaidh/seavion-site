// ---------- CONFIG ----------
const MAPBOX_TOKEN = 'pk.eyJ1IjoibWh1bWFpZGgiLCJhIjoiY21oNXc4NTBmMDc1aDJqczY2YjdqeWtwciJ9.Bk_ROk0n4KlmLaTroAWp5w';
const STYLE_URL    = 'mapbox://styles/mhumaidh/cmh53iv3j00ck01qxdkt9gyu3';

// Site(s)
const SITES = [
  { name: 'NIY', lon: 72.93961, lat: 2.68627 }
];
const REFRESH_MINUTES = 10;
// ----------------------------------------

const $status = document.getElementById('status');
const say = (m) => { console.log(m); if ($status) $status.textContent = m; };

mapboxgl.accessToken = MAPBOX_TOKEN;
const map = new mapboxgl.Map({ container: 'map', style: STYLE_URL });

map.on('error', e => { console.error('Map error:', e?.error || e); say('Map error — see console.'); });

map.on('load', async () => {
  map.resize();
  await addOrUpdateWind();
  setInterval(addOrUpdateWind, REFRESH_MINUTES * 60 * 1000);
});

// ---------- Math helpers ----------
const toRad = d => d * Math.PI / 180;
const toDeg = r => (r * 180 / Math.PI + 360) % 360;

function bracketHours(timesISO, now = Date.now()) {
  const t = timesISO.map(x => Date.parse(x));
  let k = 0; while (k < t.length - 1 && t[k+1] < now) k++;
  const k1 = Math.max(0, Math.min(k, t.length - 1));
  const k2 = Math.min(t.length - 1, k1 + 1);
  const w = (now - t[k1]) / Math.max(1, (t[k2] - t[k1]));
  return { k1, k2, w: Math.min(1, Math.max(0, w)) };
}

function mpsFromToUV(sp, fromDeg) {
  // Flip 180° so we get the direction the air is moving toward
  const to = (fromDeg + 180) % 360;
  // Convert to radians and compute u/v
  const rad = toRad(to);
  // Mapbox expects 0°=north, 90°=east — so swap axes accordingly
  return { u: sp * Math.sin(rad), v: sp * Math.cos(rad) };
}

function uvToSpeedDir(u, v) {
  const sp = Math.hypot(u, v);
  // Bearing clockwise from north (so 0°=north, 90°=east)
  const dir_to = (toDeg(Math.atan2(u, v)) + 360) % 360;
  const dir_from = (dir_to + 180) % 360;
  return { sp_mps: sp, dir_from, dir_to };
}

// ---------- Sampling helpers (reduce grid bias) ----------
function sampleOffsets(lon, lat) {
  const d = 0.12; // ~13 km near equator; tweak if you like
  return [
    { lon,        lat        },
    { lon: lon+d, lat        },
    { lon: lon-d, lat        },
    { lon,        lat: lat+d },
    { lon,        lat: lat-d },
  ];
}

// ---------- Forecast API (works for wind) ----------
async function fetchForecastPoint(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
              `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Forecast API HTTP ${r.status}`);
  const j = await r.json();
  const { k1, k2, w } = bracketHours(j.hourly.time || []);
  const sp1 = j.hourly.wind_speed_10m[k1], sp2 = j.hourly.wind_speed_10m[k2];
  const d1  = j.hourly.wind_direction_10m[k1], d2  = j.hourly.wind_direction_10m[k2];
  const { u:u1, v:v1 } = mpsFromToUV(sp1, d1);
  const { u:u2, v:v2 } = mpsFromToUV(sp2, d2);
  const u = u1*(1-w) + u2*w, v = v1*(1-w) + v2*w;
  const { sp_mps, dir_from, dir_to } = uvToSpeedDir(u, v);
  return { sp_mps, dir_from, dir_to, timeTxt: j.hourly.time[k1] };
}

// Enhanced fetch for a site: sample 5 points, vector-average
async function fetchWindSite(site) {
  const pts = sampleOffsets(site.lon, site.lat);
  const arr = await Promise.all(pts.map(p =>
    fetchForecastPoint(p.lat, p.lon).catch(() => null)
  ));
  const ok = arr.filter(Boolean);
  if (!ok.length) throw new Error('No wind samples');

  // vector-average
  const uv = ok.map(v => {
    const to = (v.dir_from + 180) % 360;
    return { u: v.sp_mps * Math.cos(toRad(to)), v: v.sp_mps * Math.sin(toRad(to)) };
  }).reduce((a,b) => ({ u: a.u + b.u, v: a.v + b.v }), { u:0, v:0 });

  uv.u /= ok.length; uv.v /= ok.length;
  const { sp_mps, dir_from, dir_to } = uvToSpeedDir(uv.u, uv.v);
  const timeTxt = ok[0].timeTxt;

  return { ...site, sp_mps, dir_from, dir_to, timeTxt };
}

async function buildWindFC() {
  const rows = await Promise.all(SITES.map(s =>
    fetchWindSite(s).catch(e => { console.warn('Wind fetch failed for', s.name, e); return null; })
  ));
  const feats = rows.filter(Boolean).map(r => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    properties: {
      name: r.name,
      wind_from: r.dir_from,
      wind_to: r.dir_to,
      wind_speed_mps: r.sp_mps,
      wind_speed_kt: r.sp_mps * 1.94384,
      label: `${(r.sp_mps * 1.94384).toFixed(1)} kt`,
      time: r.timeTxt
    }
  }));
  return { type: 'FeatureCollection', features: feats };
}

// ---------- Arrow icon via canvas (PNG bitmap) ----------
function makeArrowCanvas(size = 64, color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,size,size);
  ctx.fillStyle = color;

  // Triangle pointing up
  const w = size * 0.55;
  const h = size * 0.70;
  const x = size / 2;
  const yTop = size * 0.12;
  const yBase = yTop + h;

  ctx.beginPath();
  ctx.moveTo(x, yTop);                // tip
  ctx.lineTo(x + w/2, yBase);         // right base
  ctx.lineTo(x, yBase * 0.78);        // inner notch
  ctx.lineTo(x - w/2, yBase);         // left base
  ctx.closePath();
  ctx.fill();

  return c;
}

async function ensureArrowImage() {
  if (map.hasImage('arrow')) return;
  const canvas = makeArrowCanvas(64, '#ffffff');
  map.addImage('arrow', canvas, { pixelRatio: 2 });
}

// ---------- Draw/update ----------
async function addOrUpdateWind() {
  say('Updating wind…');
  const data = await buildWindFC();

  if (!map.getSource('wind')) {
    map.addSource('wind', { type: 'geojson', data });

    await ensureArrowImage();

    // Optional bubble (magnitude)
    map.addLayer({
      id: 'wind-bubble',
      type: 'circle',
      source: 'wind',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'wind_speed_mps'], 0, 5, 20, 16],
        'circle-opacity': 0.22,
        'circle-color': '#39a9ff'
      }
    });

    // Scaled arrows + labels
    map.addLayer({
      id: 'wind-arrows',
      type: 'symbol',
      source: 'wind',
      minzoom: 0,
      maxzoom: 24,
      layout: {
        'icon-image': 'arrow',
        'icon-size': ['interpolate', ['linear'], ['get', 'wind_speed_mps'], 0, 0.45, 10, 0.9, 20, 1.4],
        'icon-rotate': ['get', 'wind_to'],
        'icon-rotation-alignment': 'map',
        'text-field': ['get', 'label'],
        'text-offset': [0, 1.05],
        'text-size': 12,
        'text-anchor': 'top'
      },
      paint: { 'text-color': '#ffffff' }
    });

    map.addLayer({
      id: 'test-arrow',
      type: 'symbol',
      source: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [72.9396, 2.6862] },
            properties: { dir: 45 }
          }]
        }
      },
      layout: {
        'icon-image': 'arrow',
        'icon-size': 1.0,
        'icon-rotate': ['get', 'dir'],
        'icon-rotation-alignment': 'map'
      }
    });
    
    map.on('click', 'wind-arrows', e => {
      const p = e.features[0].properties;
      new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(
        `<strong>${p.name}</strong><br>` +
        `Wind: ${Number(p.wind_speed_kt).toFixed(1)} kt<br>` +
        `From: ${Number(p.wind_from).toFixed(0)}° true<br>` +
        `${(p.time || '').replace('T',' ')}`
      ).addTo(map);
    });

    map.on('mouseenter', 'wind-arrows', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'wind-arrows', () => map.getCanvas().style.cursor = '');
  } else {
    map.getSource('wind').setData(data);
  }

  say(`Wind updated • ${new Date().toLocaleTimeString()}`);
}
