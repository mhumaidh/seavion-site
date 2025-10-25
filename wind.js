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
const say = (msg) => { console.log(msg); if ($status) $status.textContent = msg; };

// Initialize map without setting center/zoom
mapboxgl.accessToken = MAPBOX_TOKEN;
const map = new mapboxgl.Map({ container: 'map', style: STYLE_URL });

map.on('error', e => {
  console.error('Map error:', e?.error || e);
  say('Map error — check console (token / style).');
});

map.on('load', async () => {
  map.resize(); // ensures correct size on load
  await addOrUpdateWind();
  setInterval(addOrUpdateWind, REFRESH_MINUTES * 60 * 1000);
});

// ---- helpers ----
const toRad = d => d * Math.PI / 180;
const toDeg = r => (r * 180 / Math.PI + 360) % 360;

function bracketingHours(timesISO, now = Date.now()) {
  const t = timesISO.map(x => Date.parse(x));
  let k = 0; while (k < t.length - 1 && t[k+1] < now) k++;
  const k1 = Math.max(0, Math.min(k, t.length - 1));
  const k2 = Math.min(t.length - 1, k1 + 1);
  const w = (now - t[k1]) / Math.max(1, (t[k2] - t[k1]));
  return { k1, k2, w: Math.min(1, Math.max(0, w)) };
}

function mpsFromToUV(sp, fromDeg) {
  const to = (fromDeg + 180) % 360;
  return { u: sp * Math.cos(toRad(to)), v: sp * Math.sin(toRad(to)) };
}
function uvToSpeedDir(u, v) {
  const sp = Math.hypot(u, v);
  const dirTo = toDeg(Math.atan2(v, u));
  const dirFrom = (dirTo + 180) % 360;
  return { sp_mps: sp, dir_from: dirFrom, dir_to: dirTo };
}

// ---- Marine wind fetch ----
async function fetchMarineWind(lat, lon) {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}` +
              `&hourly=wind_speed_10m,wind_direction_10m,wind_wave_height,wind_wave_direction&timezone=auto`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Marine API HTTP ${r.status}`);
  const j = await r.json();
  const { k1, k2, w } = bracketingHours(j.hourly.time || []);
  const sp1=j.hourly.wind_speed_10m[k1], sp2=j.hourly.wind_speed_10m[k2];
  const d1=j.hourly.wind_direction_10m[k1], d2=j.hourly.wind_direction_10m[k2];
  const {u:u1,v:v1}=mpsFromToUV(sp1,d1), {u:u2,v:v2}=mpsFromToUV(sp2,d2);
  const u=u1*(1-w)+u2*w, v=v1*(1-w)+v2*w;
  const { sp_mps, dir_from, dir_to } = uvToSpeedDir(u,v);
  const wave_h = (j.hourly.wind_wave_height[k1]*(1-w)) + (j.hourly.wind_wave_height[k2]*w);
  return { sp_mps, dir_from, dir_to, wave_h, timeTxt: j.hourly.time[k1] };
}

async function buildWindFC() {
  const results = await Promise.all(SITES.map(s =>
    fetchMarineWind(s.lat, s.lon).then(d => ({ ...s, ...d })).catch(err => {
      console.warn('Wind fetch failed for', s.name, err);
      return null;
    })
  ));
  const feats = results.filter(Boolean).map(r => ({
    type:'Feature',
    geometry:{ type:'Point', coordinates:[r.lon,r.lat] },
    properties:{
      name:r.name,
      wind_from:r.dir_from,
      wind_to:r.dir_to,
      wind_speed_mps:r.sp_mps,
      wind_speed_kt:r.sp_mps*1.94384,
      wave_h:r.wave_h,
      label:`${(r.sp_mps*1.94384).toFixed(1)} kt`,
      time:r.timeTxt
    }
  }));
  return { type:'FeatureCollection', features:feats };
}

async function addOrUpdateWind() {
  say('Updating marine wind…');
  const data = await buildWindFC();

  if (!map.getSource('wind')) {
    map.addSource('wind', { type:'geojson', data });

    // Inline arrow image (no CDN)
    const arrowSvg = `data:image/svg+xml;base64,${btoa(`
<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="white">
  <polygon points="12,2 20,18 12,14 4,18" />
</svg>`)}`
    await new Promise((res,rej)=>
      map.loadImage(arrowSvg,(e,img)=>{
        if(e) return rej(e);
        if(!map.hasImage('arrow')) map.addImage('arrow',img);
        res();
      })
    ).catch(e=>console.error('Arrow image load failed:',e));

    // Blue bubble background
    map.addLayer({
      id:'wind-bubble', type:'circle', source:'wind',
      paint:{
        'circle-radius':['interpolate',['linear'],['get','wind_speed_mps'], 0,5, 20,16],
        'circle-opacity':0.22, 'circle-color':'#39a9ff'
      }
    });

    // Scaled arrows + labels
    map.addLayer({
      id:'wind-arrows', type:'symbol', source:'wind',
      layout:{
        'icon-image':'arrow',
        'icon-size':['interpolate',['linear'],['get','wind_speed_mps'], 0,0.45, 10,0.9, 20,1.4],
        'icon-rotate':['get','wind_to'],
        'icon-rotation-alignment':'map',
        'text-field':['get','label'],
        'text-offset':[0,1.05],
        'text-size':12,
        'text-anchor':'top'
      },
      paint:{ 'text-color':'#ffffff' }
    });

    map.on('click','wind-arrows', e=>{
      const p=e.features[0].properties;
      new mapboxgl.Popup().setLngLat(e.lngLat).setHTML(
        `<strong>${p.name}</strong><br>`+
        `Wind: ${Number(p.wind_speed_kt).toFixed(1)} kt<br>`+
        `From: ${Number(p.wind_from).toFixed(0)}° true<br>`+
        `Wave height: ${(Number(p.wave_h)||0).toFixed(1)} m<br>`+
        `${(p.time||'').replace('T',' ')}`
      ).addTo(map);
    });

    map.on('mouseenter','wind-arrows',()=>map.getCanvas().style.cursor='pointer');
    map.on('mouseleave','wind-arrows',()=>map.getCanvas().style.cursor='');
  } else {
    map.getSource('wind').setData(data);
  }

  say(`Marine wind updated • ${new Date().toLocaleTimeString()}`);
}
