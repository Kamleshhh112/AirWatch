// ============================================================
//  AirWatch MB — Backend Server
//  Node.js + Express
//  Features: Real WAQI API, Login/Register, JWT Auth, CORS
// ============================================================

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const fetch      = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── WAQI API Token
const WAQI_TOKEN = process.env.WAQI_TOKEN || '406e36c0c370fa2aac1aaa664c9d81771a48b8b0';

// ── JWT secret — change this to any long random string in production
const JWT_SECRET = process.env.JWT_SECRET || 'airwatch_mb_super_secret_2024';

// ── Simple file-based "database" (no MongoDB needed for viva!)
const DB_FILE = path.join(__dirname, 'db.json');
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: [], reports: [] }; }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
if (!fs.existsSync(DB_FILE)) writeDB({ users: [], reports: [] });

// ── Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html

// ── Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ============================================================
//  AUTH ROUTES
// ============================================================

// POST /api/register
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'All fields required' });

  const db = readDB();
  if (db.users.find(u => u.email === email))
    return res.status(409).json({ error: 'Email already registered' });

  const hashed = await bcrypt.hash(password, 10);
  const user = { id: Date.now(), name, email, password: hashed, createdAt: new Date().toISOString() };
  db.users.push(user);
  writeDB(db);

  const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const db = readDB();
  const user = db.users.find(u => u.email === email);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

// GET /api/me  (protected)
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ============================================================
//  AQI DATA ROUTES — Real WAQI API
// ============================================================

const ZONES = [
  { name: 'Mira Road East', id: 'miraeast',  lat: 19.2813, lng: 72.8697 },
  { name: 'Mira Road West', id: 'mirawest',  lat: 19.2652, lng: 72.8437 },
  { name: 'Bhayander East', id: 'bhayeast',  lat: 19.3058, lng: 72.8777 },
  { name: 'Bhayander West', id: 'bhaywest',  lat: 19.3141, lng: 72.8566 },
  { name: 'Kashimira',      id: 'kashimira', lat: 19.2403, lng: 72.8777 },
  { name: 'Gorai',          id: 'gorai',     lat: 19.2252, lng: 72.8050 },
  { name: 'Uttan Beach',    id: 'uttan',     lat: 19.2013, lng: 72.7883 },
  { name: 'Naigaon',        id: 'naigaon',   lat: 19.3572, lng: 72.8536 },
  { name: 'Vasai',          id: 'vasai',     lat: 19.3662, lng: 72.8170 },
];

// Fetch single zone data from WAQI by GPS
async function fetchWAQI(lat, lng) {
  try {
    const url = `https://api.waqi.info/feed/geo:${lat};${lng}/?token=${WAQI_TOKEN}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const json = await res.json();
    if (json.status === 'ok' && json.data && json.data.aqi !== '-') {
      const d   = json.data;
      const aqi = typeof d.aqi === 'number' ? d.aqi : parseInt(d.aqi) || 0;
      return {
        aqi,
        station : d.city?.name || 'Unknown Station',
        pm25    : d.iaqi?.pm25?.v ?? null,
        pm10    : d.iaqi?.pm10?.v ?? null,
        no2     : d.iaqi?.no2?.v  ?? null,
        o3      : d.iaqi?.o3?.v   ?? null,
        so2     : d.iaqi?.so2?.v  ?? null,
        co      : d.iaqi?.co?.v   ?? null,
        temp    : d.iaqi?.t?.v    ?? null,
        humidity: d.iaqi?.h?.v    ?? null,
        time    : d.time?.s       || new Date().toISOString(),
        isLive  : true
      };
    }
  } catch (e) { /* fall through */ }
  return null;
}

// Build fallback (simulated) data
function fallbackData(zone) {
  const base = { miraeast:190, mirawest:145, bhayeast:130, bhaywest:135,
                 kashimira:195, gorai:60, uttan:45, naigaon:155, vasai:70 };
  const aqi  = (base[zone.id] || 120) + Math.floor((Math.random() - 0.5) * 20);
  return {
    aqi     : Math.max(10, aqi),
    station : zone.name + ' (Estimated)',
    pm25    : Math.round(aqi * 0.72),
    pm10    : Math.round(aqi * 0.45),
    no2     : Math.round(aqi * 0.22),
    o3      : Math.round(aqi * 0.12),
    so2     : Math.round(aqi * 0.04),
    co      : +(aqi * 0.007).toFixed(1),
    temp    : 28 + Math.floor(Math.random() * 5),
    humidity: 70 + Math.floor(Math.random() * 15),
    time    : new Date().toISOString(),
    isLive  : false
  };
}

// GET /api/aqi — all zones
app.get('/api/aqi', async (req, res) => {
  const results = await Promise.allSettled(
    ZONES.map(z => fetchWAQI(z.lat, z.lng))
  );
  const data = {};
  results.forEach((r, i) => {
    const zone = ZONES[i];
    data[zone.id] = (r.status === 'fulfilled' && r.value)
      ? { ...r.value, name: zone.name, id: zone.id, lat: zone.lat, lng: zone.lng }
      : { ...fallbackData(zone), name: zone.name, id: zone.id, lat: zone.lat, lng: zone.lng };
  });
  res.json({ success: true, data, fetchedAt: new Date().toISOString() });
});

// GET /api/aqi/:zoneId — single zone
app.get('/api/aqi/:zoneId', async (req, res) => {
  const zone = ZONES.find(z => z.id === req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  const live = await fetchWAQI(zone.lat, zone.lng);
  const data = live
    ? { ...live, name: zone.name, id: zone.id }
    : { ...fallbackData(zone), name: zone.name, id: zone.id };
  res.json({ success: true, data });
});

// GET /api/aqi/gps?lat=XX&lng=YY — user GPS location
app.get('/api/aqi/gps', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  const live = await fetchWAQI(parseFloat(lat), parseFloat(lng));
  if (live) return res.json({ success: true, data: live });
  res.json({ success: false, error: 'No data for this location' });
});

// ============================================================
//  PUBLIC REPORTS ROUTES
// ============================================================

// GET /api/reports
app.get('/api/reports', (req, res) => {
  const db = readDB();
  res.json({ success: true, reports: db.reports.slice(0, 100) });
});

// POST /api/reports  (protected — must be logged in)
app.post('/api/reports', authMiddleware, (req, res) => {
  const { zone, severity, conditions, note } = req.body;
  if (!zone || !severity) return res.status(400).json({ error: 'zone and severity required' });

  const db     = readDB();
  const report = {
    id        : Date.now(),
    zone, severity,
    conditions: conditions || [],
    note      : note || '',
    name      : req.user.name,
    userId    : req.user.id,
    time      : new Date().toISOString(),
    votes     : 0
  };
  db.reports.unshift(report);
  if (db.reports.length > 200) db.reports = db.reports.slice(0, 200);
  writeDB(db);
  res.json({ success: true, report });
});

// POST /api/reports/:id/vote
app.post('/api/reports/:id/vote', authMiddleware, (req, res) => {
  const db     = readDB();
  const report = db.reports.find(r => r.id === parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: 'Report not found' });
  report.votes = (report.votes || 0) + 1;
  writeDB(db);
  res.json({ success: true, votes: report.votes });
});


app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────┐
  │   🌬  AirWatch MB — Backend Running     │
  │   http://localhost:${PORT}                  │
  │                                         │
  │   API Endpoints:                        │
  │   POST /api/register                    │
  │   POST /api/login                       │
  │   GET  /api/me          (auth)          │
  │   GET  /api/aqi         (all zones)     │
  │   GET  /api/aqi/:zoneId                 │
  │   GET  /api/aqi/gps?lat=&lng=           │
  │   GET  /api/reports                     │
  │   POST /api/reports     (auth)          │
  └─────────────────────────────────────────┘
  `);
});