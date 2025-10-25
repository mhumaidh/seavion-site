// ---------- CONFIG ----------
const MAPBOX_TOKEN = 'pk.eyJ1IjoibWh1bWFpZGgiLCJhIjoiY21oNXc4NTBmMDc1aDJqczY2YjdqeWtwciJ9.Bk_ROk0n4KlmLaTroAWp5w';
const STYLE_URL = 'mapbox://styles/mhumaidh/cmh53iv3j00ck01qxdkt9gyu3';

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

// ---------- Helpers ----------
const toRad = d => d * Math.PI / 180;
const toDeg = r => (r * 180 / Math.PI + 360) % 360;

// API Fetch
async function fetchForecastPoint(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=auto`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();

  const times = j.hourly.time.map(t => Date.parse(t));
  const now = Date.now();
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(times[i] - now);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }

  const sp = j.hourly.wind_speed_10m[best];
  const from = j.hourly.wind_direction_10m[best];
  return { sp, from };
}

// Convert wind direction and components
function mpsFromToUV(sp, fromDeg) {
  const to = (fromDeg + 180) % 360; // FROM → TO
  const rad = toRad(to);
  // Convert to east-based components (u = east, v = north)
  return { u: sp * Math.sin(rad), v: sp * Math.cos(rad) };
}

function uvToSpeedDir(u, v) {
  const sp = Math.hypot(u, v);
  // East-based rotation (CW from east) for Mapbox
  const dir_to_east = (toDeg(Math.atan2(v, u)) + 360) % 360;
  const dir_from_east = (dir_to_east + 180) % 360;
  return { sp_mps: sp, dir_from_east, dir_to_east };
}

// Build feature collection
async function buildWindFC() {
  const feats = [];

  for (const site of SITES) {
    try {
      const { sp, from } = await fetchForecastPoint(site.lat, site.lon);
      const { u, v } = mpsFromToUV(sp, from);
      const { sp_mps, dir_to_east } = uvToSpeedDir(u, v);

      feats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [site.lon, site.lat] },
        properties: {
          name: site.name,
          wind_to: dir_to_east,
          wind_speed_mps: sp_mps,
          wind_speed_kt: sp_mps * 1.94384,
          label: `${(sp_mps * 1.94384).toFixed(1)} kt`
        }
      });
    } catch (err) {
      console.warn('Wind fetch failed for', site.name, err);
    }
  }

  return { type: 'FeatureCollection', features: feats };
}

// Create arrow image
function makeArrowCanvas(size = 64, color = '#fff') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(size/2, size*0.1);
  ctx.lineTo(size*0.9, size*0.9);
  ctx.lineTo(size/2, size*0.7);
  ctx.lineTo(size*0.1, size*0.9);
  ctx.closePath();
  ctx.fill();
  return c;
}

async function ensureArrowImage() {
  if (map.hasImage('arrow')) return;
  const canvas = makeArrowCanvas(64, '#ffffff');
  map.addImage('arrow', canvas, { pixelRatio: 2 });
}

// Add/update wind layer
async function addOrUpdateWind() {
  say('Updating wind…');
  const data = await buildWindFC();

  if (!map.getSource('wind')) {
    map.addSource('wind', { type: 'geojson', data });
    await ensureArrowImage();

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

    map.addLayer({
      id: 'wind-arrows',
      type: 'symbol',
      source: 'wind',
      layout: {
        'icon-image': 'arrow',
        'icon-size': ['interpolate', ['linear'], ['get', 'wind_speed_mps'], 0, 0.45, 10, 0.9, 20, 1.4],
        'icon-rotate': ['get', 'wind_to'], // east-based rotation
        'icon-rotation-alignment': 'map',
        'text-field': ['get', 'label'],
        'text-offset': [0, 1.05],
        'text-size': 12,
        'text-anchor': 'top'
      },
      paint: { 'text-color': '#ffffff' }
    });
  } else {
    map.getSource('wind').setData(data);
  }

  say(`Wind updated • ${new Date().toLocaleTimeString()}`);
}
