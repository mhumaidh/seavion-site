// ---------- CONFIG (edit these) ----------
const MAPBOX_TOKEN = 'pk.eyJ1IjoibWh1bWFpZGgiLCJhIjoiY21oNXc4NTBmMDc1aDJqczY2YjdqeWtwciJ9.Bk_ROk0n4KlmLaTroAWp5w';  // add https://seavion.app to Allowed URLs
const STYLE_URL    = 'mapbox://styles/mhumaidh/cmh53iv3j00ck01qxdkt9gyu3'; // your published style

// Add/modify your sites (lon, lat):
const SITES = [
  { name: 'NIY', lon: 72.93960976474132	, lat: 2.686273100482876}, 
  // …add more
];

const REFRESH_MINUTES = 10;
// ----------------------------------------

const $status = document.getElementById('status');
const say = (msg) => { console.log(msg); if ($status) $status.textContent = msg; };

// Init map without center/zoom so it uses Studio’s default camera
mapboxgl.accessToken = MAPBOX_TOKEN;
const map = new mapboxgl.Map({
  container: 'map',
  style: STYLE_URL
});

map.on('error', (e) => {
  console.error('Map error:', e?.error || e);
  say('Map error — check console (token / Allowed URLs / style).');
});

map.on('load', async () => {
  try {
    // Ensure proper sizing if container changed during load
    map.resize();
    await addOrUpdateWind();
    setInterval(addOrUpdateWind, REFRESH_MINUTES * 60 * 1000);
  } catch (e) {
    console.error('Init failed:', e);
    say('Init failed — see console.');
  }
});

// ----- Wind module -----
function nearestHourIndex(times) {
  const now = Date.now();
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = Date.parse(times[i]);
    const d = Math.abs(t - now);
    if (d < bestDiff) { best = i; bestDiff = d; }
  }
  return best;
}

async function fetchWind(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
              `&hourly=wind_speed_10m,wind_direction_10m&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  const j = await r.json();
  const k = nearestHourIndex(j.hourly.time || []);
  const sp   = j.hourly.wind_speed_10m?.[k];
  const from = j.hourly.wind_direction_10m?.[k];  // FROM bearing (deg, met)
  if (sp == null || from == null) throw new Error('Missing wind fields');
  const to = (from + 180) % 360;                  // arrow points where wind goes
  return { speed_mps: sp, from_deg: from, to_deg: to, time: j.hourly.time[k] };
}

async function buildWindFC() {
  const results = await Promise.all(SITES.map(s =>
    fetchWind(s.lat, s.lon).then(d => ({ ...s, ...d })).catch(err => {
      console.warn('Wind fetch failed for', s.name, err);
      return null;
    })
  ));
  const feats = results.filter(Boolean).map(r => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    properties: {
      name: r.name,
      wind_from: r.from_deg,
      wind_to: r.to_deg,
      wind_speed_mps: r.speed_mps,
      wind_speed_kt: r.speed_mps * 1.94384,
      label: `${(r.speed_mps * 1.94384).toFixed(1)} kt`,
      time: r.time
    }
  }));
  return { type: 'FeatureCollection', features: feats };
}

async function addOrUpdateWind() {
  say('Updating wind…');
  const data = await buildWindFC();

  if (!map.getSource('wind')) {
    map.addSource('wind', { type: 'geojson', data });

    // Load arrow image once
    if (!map.hasImage('arrow')) {
      await new Promise((resolve, reject) => {
        map.loadImage('https://docs.mapbox.com/mapbox-gl-js/assets/arrow.png', (err, img) => {
          if (err) return reject(err);
          map.addImage('arrow', img);
          resolve();
        });
      }).catch(e => { console.error('Arrow image load failed:', e); });
    }

    // Optional bubble scaled by speed (m/s)
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

    // Arrows + speed label (knots)
    map.addLayer({
      id: 'wind-arrows',
      type: 'symbol',
      source: 'wind',
      layout: {
        'icon-image': 'arrow',
        'icon-size': 0.65,
        'icon-rotate': ['get', 'wind_to'],
        'icon-rotation-alignment': 'map',
        'text-field': ['get', 'label'],
        'text-offset': [0, 1.05],
        'text-size': 12,
        'text-anchor': 'top'
      },
      paint: { 'text-color': '#ffffff' }
    });

    // Click popup
    map.on('click', 'wind-arrows', (e) => {
      const p = e.features[0].properties;
      new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(
          `<strong>${p.name}</strong><br>` +
          `Wind: ${Number(p.wind_speed_kt).toFixed(1)} kt<br>` +
          `From: ${Number(p.wind_from).toFixed(0)}° true<br>` +
          `${(p.time || '').replace('T', ' ')}`
        )
        .addTo(map);
    });

    map.on('mouseenter', 'wind-arrows', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'wind-arrows', () => map.getCanvas().style.cursor = '');
  } else {
    map.getSource('wind').setData(data);
  }

  say(`Wind updated • ${new Date().toLocaleTimeString()}`);
}
