const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const { db, tx, CROPS, metrics, shelfLifeAtReceipt, farmerKey, newBatchId, seedDemo } = require('./db');

const PORT = process.env.PORT || 3000;
const PIN = process.env.STAFF_PIN || '1234';
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!db.prepare('SELECT 1 FROM batches LIMIT 1').get() && process.env.SEED_DEMO !== '0') seedDemo();

// ---------- helpers ----------
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const str = (v, max = 40) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
const num = (v, min, max) => { const n = Number(v); return v !== '' && v != null && isFinite(n) && n >= min && n <= max ? n : null; };
const isoDate = (v) => { const d = new Date(v); return v && !isNaN(d) ? d.toISOString() : null; };
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

const bad = new Map(); // IP -> {n, until}  (PIN brute-force guard)
function staff(req, res, next) {
  const ip = req.ip, s = bad.get(ip);
  if (s && s.until > Date.now()) return fail(res, 429, 'Too many wrong PINs. Try again in a few minutes.');
  if ((req.get('x-staff-pin') || req.query.pin) === PIN) return next();
  const n = (s ? s.n : 0) + 1;
  bad.set(ip, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
  fail(res, 401, 'Wrong staff PIN');
}

const getBatch = (id) => db.prepare('SELECT * FROM batches WHERE batch_id=?').get(id);
const getMandi = (id) => db.prepare('SELECT * FROM mandi_events WHERE batch_id=?').get(id);
const getRetail = (id) => db.prepare('SELECT * FROM retailer_events WHERE batch_id=?').get(id);

// Consumer-safe view: no auction price, no mandi quality score (Slide 9: "no financial data is shared").
function publicView(b) {
  const m = getMandi(b.batch_id), r = getRetail(b.batch_id);
  return {
    batch_id: b.batch_id, crop_type: b.crop_type, quality_grade: b.quality_grade,
    farm: { farmer_id: b.farmer_id, lat: b.farm_lat, lng: b.farm_lng },
    harvest_datetime: b.harvest_datetime,
    mandi: m && { mandi_id: m.mandi_id, arrival_timestamp: m.arrival_timestamp, transport_id: m.transport_id },
    retailer: r && { retailer_id: r.retailer_id, received_timestamp: r.received_timestamp,
      shelf_price_per_kg: r.shelf_price_per_kg, storage_condition: r.storage_condition, shelf_life_days: r.shelf_life_days },
    metrics: metrics(b, m, r),
  };
}

// ---------- public ----------
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/crops', (_req, res) => res.json(CROPS));

app.get('/api/batches/:id', (req, res) => {
  const b = getBatch(req.params.id);
  b ? res.json(publicView(b)) : fail(res, 404, 'Batch not found');
});

// Consumer scan: store a scan row with the computed metrics.
app.post('/api/batches/:id/scan', (req, res) => {
  const b = getBatch(req.params.id);
  if (!b) return fail(res, 404, 'Batch not found');
  const view = publicView(b), mt = view.metrics;
  const info = db.prepare(`INSERT INTO scans (batch_id,scan_timestamp,days_since_harvest,freshness_score,handler_count)
    VALUES (?,?,?,?,?)`).run(b.batch_id, new Date().toISOString(), mt.days_since_harvest, mt.freshness_score, mt.handler_count);
  res.json({ ...view, scan_id: info.lastInsertRowid });
});

app.post('/api/scans/:scanId/feedback', (req, res) => {
  const r = num(req.body.rating, 1, 5);
  if (!r) return fail(res, 400, 'Rating must be 1 to 5');
  const x = db.prepare('UPDATE scans SET feedback_rating=? WHERE id=?').run(Math.round(r), req.params.scanId);
  x.changes ? res.json({ ok: true }) : fail(res, 404, 'Scan not found');
});

app.get('/api/qr/:id.svg', async (req, res) => {
  if (!getBatch(req.params.id)) return fail(res, 404, 'Batch not found');
  const svg = await QRCode.toString(`${baseUrl(req)}/b/${req.params.id}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').send(svg);
});

// ---------- staff (Farm / Mandi / Retailer data entry) ----------
app.post('/api/auth', staff, (_req, res) => res.json({ ok: true }));

app.post('/api/batches', staff, (req, res) => {
  const b = req.body, farmer_id = str(b.farmer_id, 20), crop = CROPS.includes(b.crop_type) ? b.crop_type : null;
  const qty = num(b.quantity_kg, 0.1, 100000), harvest = isoDate(b.harvest_datetime);
  const grade = ['A', 'B', 'C'].includes(b.quality_grade) ? b.quality_grade : null;
  const lat = b.farm_lat === '' || b.farm_lat == null ? null : num(b.farm_lat, -90, 90);
  const lng = b.farm_lng === '' || b.farm_lng == null ? null : num(b.farm_lng, -180, 180);
  if (!farmer_id || !crop || !qty || !harvest || !grade) return fail(res, 400, 'Please fill farmer ID, crop, quantity, grade and harvest time');
  const id = tx(() => {
    const bid = newBatchId(harvest);
    db.prepare(`INSERT INTO batches (batch_id,farmer_id,crop_type,harvest_datetime,farm_lat,farm_lng,quantity_kg,quality_grade)
      VALUES (?,?,?,?,?,?,?,?)`).run(bid, farmer_id.toUpperCase(), crop, harvest, lat, lng, qty, grade);
    return bid;
  });
  res.status(201).json({ batch_id: id, farmer_key: farmerKey(farmer_id.toUpperCase()), qr: `/api/qr/${id}.svg`, label: `/label/${id}` });
});

app.put('/api/batches/:id/mandi', staff, (req, res) => {
  const b = getBatch(req.params.id);
  if (!b) return fail(res, 404, 'Batch not found. Check the batch ID.');
  const x = req.body, mandi_id = str(x.mandi_id, 20), arr = isoDate(x.arrival_timestamp);
  const price = x.auction_price_per_kg === '' ? null : num(x.auction_price_per_kg, 0, 10000);
  const q = x.quality_check_score === '' ? null : num(x.quality_check_score, 0, 100);
  if (!mandi_id || !arr) return fail(res, 400, 'Mandi ID and arrival time are required');
  db.prepare(`INSERT INTO mandi_events VALUES (?,?,?,?,?,?)
    ON CONFLICT(batch_id) DO UPDATE SET mandi_id=excluded.mandi_id, arrival_timestamp=excluded.arrival_timestamp,
    transport_id=excluded.transport_id, auction_price_per_kg=excluded.auction_price_per_kg, quality_check_score=excluded.quality_check_score`)
    .run(b.batch_id, mandi_id.toUpperCase(), arr, str(x.transport_id, 20), price, q == null ? null : Math.round(q));
  res.json({ ok: true });
});

app.put('/api/batches/:id/retailer', staff, (req, res) => {
  const b = getBatch(req.params.id);
  if (!b) return fail(res, 404, 'Batch not found. Check the batch ID.');
  const x = req.body, rid = str(x.retailer_id, 20), rec = isoDate(x.received_timestamp);
  const price = x.shelf_price_per_kg === '' ? null : num(x.shelf_price_per_kg, 0, 10000);
  const storage = ['Ambient', 'Cold'].includes(x.storage_condition) ? x.storage_condition : null;
  if (!rid || !rec || !storage) return fail(res, 400, 'Retailer ID, received time and storage are required');
  db.prepare(`INSERT INTO retailer_events VALUES (?,?,?,?,?,?)
    ON CONFLICT(batch_id) DO UPDATE SET retailer_id=excluded.retailer_id, received_timestamp=excluded.received_timestamp,
    shelf_price_per_kg=excluded.shelf_price_per_kg, storage_condition=excluded.storage_condition, shelf_life_days=excluded.shelf_life_days`)
    .run(b.batch_id, rid.toUpperCase(), rec, price, storage, shelfLifeAtReceipt(b, rec, storage));
  res.json({ ok: true });
});

app.get('/api/batches', staff, (_req, res) => {
  res.json(db.prepare(`SELECT b.batch_id,b.farmer_id,b.crop_type,b.quantity_kg,b.harvest_datetime,
    (m.batch_id IS NOT NULL) AS at_mandi,(r.batch_id IS NOT NULL) AS at_retailer,
    (SELECT COUNT(*) FROM scans s WHERE s.batch_id=b.batch_id) AS scans
    FROM batches b LEFT JOIN mandi_events m USING(batch_id) LEFT JOIN retailer_events r USING(batch_id)
    ORDER BY b.created_at DESC, b.batch_id DESC LIMIT 30`).all());
});

app.get('/api/farmer-key/:id', staff, (req, res) => res.json({ farmer_key: farmerKey(req.params.id.toUpperCase()) }));

app.get('/api/export.csv', staff, (_req, res) => {
  const rows = db.prepare(`SELECT b.batch_id,b.farmer_id,b.crop_type,b.harvest_datetime,b.farm_lat,b.farm_lng,b.quantity_kg,b.quality_grade,
    m.mandi_id,m.arrival_timestamp,m.transport_id,m.auction_price_per_kg,m.quality_check_score,
    r.retailer_id,r.received_timestamp,r.shelf_price_per_kg,r.storage_condition,r.shelf_life_days,
    s.scan_timestamp,s.days_since_harvest,s.freshness_score,s.handler_count,s.feedback_rating
    FROM batches b LEFT JOIN mandi_events m USING(batch_id) LEFT JOIN retailer_events r USING(batch_id)
    LEFT JOIN scans s USING(batch_id) ORDER BY b.batch_id, s.id`).all();
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const q = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  res.type('text/csv').attachment('freshtrace_export.csv')
    .send([cols.join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\n'));
});

// ---------- farmer dashboard: where did my produce go? ----------
app.get('/api/farmer/:id', (req, res) => {
  const id = req.params.id.toUpperCase();
  if ((req.get('x-farmer-key') || '') !== farmerKey(id) && req.get('x-staff-pin') !== PIN) return fail(res, 401, 'Wrong farmer key');
  const batches = db.prepare(`SELECT b.batch_id,b.crop_type,b.quantity_kg,b.quality_grade,b.harvest_datetime,
    m.mandi_id,m.arrival_timestamp,m.auction_price_per_kg,m.quality_check_score,
    r.retailer_id,r.received_timestamp,r.shelf_price_per_kg,r.storage_condition,
    (SELECT COUNT(*) FROM scans s WHERE s.batch_id=b.batch_id) AS scans,
    (SELECT ROUND(AVG(feedback_rating),1) FROM scans s WHERE s.batch_id=b.batch_id) AS avg_rating
    FROM batches b LEFT JOIN mandi_events m USING(batch_id) LEFT JOIN retailer_events r USING(batch_id)
    WHERE b.farmer_id=? ORDER BY b.harvest_datetime DESC`).all(id);
  const rated = batches.filter(b => b.avg_rating != null);
  res.json({ farmer_id: id, batches: batches.map(b => ({ ...b, ...metrics(
      { harvest_datetime: b.harvest_datetime, crop_type: b.crop_type, quality_grade: b.quality_grade },
      b.mandi_id ? { quality_check_score: b.quality_check_score } : null,
      b.retailer_id ? { storage_condition: b.storage_condition } : null) })),
    totals: { batches: batches.length, kg: batches.reduce((a, b) => a + b.quantity_kg, 0),
      scans: batches.reduce((a, b) => a + b.scans, 0),
      avg_rating: rated.length ? +(rated.reduce((a, b) => a + b.avg_rating, 0) / rated.length).toFixed(1) : null } });
});

// ---------- pages ----------
const page = (f) => (_req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/b/:id', page('b.html'));
app.get('/label/:id', page('label.html'));
app.get('/farmer', page('farmer.html'));
app.get('/staff', page('staff.html'));

app.listen(PORT, () => console.log(`FreshTrace running on port ${PORT}`));
