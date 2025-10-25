// ---------- CONFIG ----------
const MAPBOX_TOKEN = 'pk.eyJ1IjoibWh1bWFpZGgiLCJhIjoiY21oNXc4NTBmMDc1aDJqczY2YjdqeWtwciJ9.Bk_ROk0n4KlmLaTroAWp5w';
const STYLE_URL     = 'mapbox://styles/mhumaidh/cmh53iv3j00ck01qxdkt9gyu3';
const SITES = [{ name: 'NIY', lon: 72.93961, lat: 2.68627 }];
const REFRESH_MINUTES = 10;

// Final rotation tweak applied to every arrow (degrees).
// Your renderer is 90° clockwise off → rotate 90° counter-clockwise.
const ROT_OFFSET_DEG = -90;
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

async function fetchForecastPoint(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
            + `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();

  const ts = j.hourly.time.map(t => Date.parse(t));
  const now = Date.now();
  let k = 0, best = 1e15;
  for (let i = 0; i < ts.length; i++) {
    const d = Math.abs(ts[i] - now);
    if (d < best) { best = d; k = i; }
  }
  return {
    sp_mps: j.hourly.wind_speed_10m[k],
    from_deg: j.hourly.wind_direction_10m[k]
  };
}

// FROM→TO, then components (u east, v north)
function mpsFromToUV(sp, fromDeg) {
  const toDegNorth = (fromDeg + 180) % 360; // show where air is GOING
  const rad = toRad(toDegNorth);
  return { u: sp * Math.sin(rad), v: sp * Math.cos(rad) };
}

// Components → bearings
function uvToSpeedDir(u, v) {
  const sp = Math.hypot(u, v);
  // North-based "to" (CW from north)
  const dir_to_north = (toDeg(Math.atan2(u, v)) + 360) % 360;
  const dir_from_north = (dir_to_north + 180) % 360;

  // Apply global calibration so Mapbox renders the expected quadrant
  const dir_to_render = (dir_to_north + ROT_OFFSET_DEG + 360) % 360;

  return { sp_mps: sp, dir_from_north, dir_to_north, dir_to_render };
}

async function buildWindFC() {
  const feats = [];
  for (const site of SITES) {
    try {
      const { sp_mps, from_deg } = await fetchForecastPoint(site.lat, site.lon);
      const { u, v } = mpsFromToUV(sp_mps, from_deg);
      const { sp_mps: sp, dir_to_render, dir_to_north } = uvToSpeedDir(u, v);

      feats.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [site.lon, site.lat] },
        properties: {
          name: site.name,
          wind_rotate: dir_to_render,            // <— use this for icon-rotate
          wind_to_north: dir_to_north,           // optional (for popup/debug)
          wind_speed_mps: sp,
          wind_speed_kt: sp * 1.94384,
          label: `${(sp * 1.94384).toFixed(1)} kt`
        }
      });
    } catch (e) {
      console.warn('Wind fetch failed for', site.name, e);
    }
  }
  return { type: 'FeatureCollection', features: feats };
}

// Arrow bitmap (PNG via canvas — robust in GL JS v3)
function makeArrowCanvas(size = 64, color = '#fff') {
  const c = document.createElement('canvas'); c.width = c.height = size;
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
        'icon-rotate': ['get', 'wind_rotate'],  // <— rotated with global offset
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
