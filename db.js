const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, so no C++ build tools needed
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'freshtrace.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Schema follows Slide 5 (Q4) of the submitted worksheet, stage by stage.
db.exec(`
CREATE TABLE IF NOT EXISTS batches (            -- FARM
  batch_id TEXT PRIMARY KEY,
  farmer_id TEXT NOT NULL,
  crop_type TEXT NOT NULL,
  harvest_datetime TEXT NOT NULL,
  farm_lat REAL, farm_lng REAL,                 -- farm_gps
  quantity_kg REAL NOT NULL,
  quality_grade TEXT NOT NULL CHECK (quality_grade IN ('A','B','C')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mandi_events (       -- MANDI
  batch_id TEXT PRIMARY KEY REFERENCES batches(batch_id),
  mandi_id TEXT NOT NULL,
  arrival_timestamp TEXT NOT NULL,
  transport_id TEXT,
  auction_price_per_kg REAL,
  quality_check_score INTEGER CHECK (quality_check_score BETWEEN 0 AND 100)
);
CREATE TABLE IF NOT EXISTS retailer_events (    -- RETAILER
  batch_id TEXT PRIMARY KEY REFERENCES batches(batch_id),
  retailer_id TEXT NOT NULL,
  received_timestamp TEXT NOT NULL,
  shelf_price_per_kg REAL,
  storage_condition TEXT CHECK (storage_condition IN ('Ambient','Cold')),
  shelf_life_days INTEGER                       -- computed
);
CREATE TABLE IF NOT EXISTS scans (              -- CONSUMER
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES batches(batch_id),
  scan_timestamp TEXT NOT NULL,
  days_since_harvest INTEGER,                   -- computed
  freshness_score INTEGER,                      -- computed
  handler_count INTEGER,                        -- computed
  feedback_rating INTEGER CHECK (feedback_rating IS NULL OR feedback_rating BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS idx_batches_farmer ON batches(farmer_id);
CREATE INDEX IF NOT EXISTS idx_scans_batch ON scans(batch_id);
`);

// Typical shelf life in days at ambient temperature (cold storage doubles it).
const SHELF = { Tomato: 7, Potato: 30, Onion: 30, Spinach: 3, Brinjal: 6, Cabbage: 10,
  Carrot: 14, Okra: 4, Cauliflower: 6, Chilli: 7, Capsicum: 8, Beans: 5 };
const CROPS = Object.keys(SHELF);
const DAY = 864e5;

function totalShelf(crop, storage) { return (SHELF[crop] || 5) * (storage === 'Cold' ? 2 : 1); }

function metrics(b, m, r, now = new Date()) {
  const age = Math.max(0, (now - new Date(b.harvest_datetime)) / DAY);
  const total = totalShelf(b.crop_type, r && r.storage_condition);
  let score = { A: 100, B: 92, C: 84 }[b.quality_grade] - 60 * age / total;
  if (m && m.quality_check_score != null) score = 0.7 * score + 0.3 * m.quality_check_score;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 80 ? 'Very fresh' : score >= 60 ? 'Fresh' : score >= 40 ? 'Use soon' : 'Past its best';
  return { days_since_harvest: Math.floor(age), freshness_score: score, freshness_label: label,
    handler_count: 1 + (m ? 1 : 0) + (r ? 1 : 0) };
}

function shelfLifeAtReceipt(b, receivedISO, storage) {
  const age = Math.max(0, (new Date(receivedISO) - new Date(b.harvest_datetime)) / DAY);
  return Math.max(0, Math.round(totalShelf(b.crop_type, storage) - age));
}

const SECRET = process.env.APP_SECRET || (process.env.STAFF_PIN || '1234') + '-freshtrace';
function farmerKey(farmerId) {
  const h = crypto.createHmac('sha256', SECRET).update(String(farmerId)).digest('hex');
  return String(parseInt(h.slice(0, 8), 16) % 1000000).padStart(6, '0');
}

function newBatchId(harvestISO) {
  const d = new Date(new Date(harvestISO).getTime() + 19800000).toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `BATCH-${d}-`;
  const row = db.prepare(`SELECT batch_id FROM batches WHERE batch_id LIKE ? || '%' ORDER BY batch_id DESC LIMIT 1`).get(prefix);
  const n = row ? parseInt(row.batch_id.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(2, '0');
}

function seedDemo() {
  const now = Date.now(), iso = (h) => new Date(now - h * 3600e3).toISOString();
  db.prepare('DELETE FROM scans WHERE batch_id=?').run('BATCH-DEMO-01');
  db.prepare('DELETE FROM mandi_events WHERE batch_id=?').run('BATCH-DEMO-01');
  db.prepare('DELETE FROM retailer_events WHERE batch_id=?').run('BATCH-DEMO-01');
  db.prepare('DELETE FROM batches WHERE batch_id=?').run('BATCH-DEMO-01');
  db.prepare(`INSERT INTO batches (batch_id,farmer_id,crop_type,harvest_datetime,farm_lat,farm_lng,quantity_kg,quality_grade)
    VALUES ('BATCH-DEMO-01','FARM-0452','Tomato',?,11.0168,76.9558,240.5,'A')`).run(iso(26));
  db.prepare(`INSERT INTO mandi_events VALUES ('BATCH-DEMO-01','MANDI-014',?,'TRK-2291',18.5,88)`).run(iso(18.5));
  db.prepare(`INSERT INTO retailer_events VALUES ('BATCH-DEMO-01','RET-337',?,32,'Ambient',?)`)
    .run(iso(2), 6);
}

module.exports = { db, tx, CROPS, metrics, shelfLifeAtReceipt, farmerKey, newBatchId, seedDemo };
