# FreshTrace – Farm to Table, Tracked
QR-code batch tracking for vegetables: **farm → mandi → shop → shopper**. Built for HCL Jigsaw Round 2 (Grade 9). The database follows the schema from our worksheet (Q4).

## Run on your laptop (2 minutes)
```
npm install
npm start          # http://localhost:3000   (staff PIN defaults to 1234)
```
A demo batch `BATCH-DEMO-01` is created on first start. Run `npm run seed` any time to reset its timestamps to "now" (do this just before recording the video).

## Deploy (free) – Render
1. Push this folder to a GitHub repo.
2. Render → New → **Blueprint** → pick the repo (it reads `render.yaml`). Set `STAFF_PIN` when asked.
3. Open the URL you get. Print QR labels from the staff page: they automatically use your live URL.
> Free Render sites forget the database when they restart. That is fine for a demo (the demo batch comes back). To keep data, add a Render Disk (paid) mounted at `/var/data` and set `DATABASE_PATH=/var/data/freshtrace.db`, or deploy the included `Dockerfile` on Railway/Fly.io with a volume at `/data`.

## How the team uses it
| Who | Page | What they do |
|---|---|---|
| Farm | `/staff` → Farm | Enter farmer ID, crop, kg, grade, harvest time, GPS → batch ID + QR. Press **Print label** and stick it on the crate |
| Mandi | `/staff` → Mandi | Scan the QR (📷) or type batch ID; save arrival time, truck ID, price, quality score |
| Shop | `/staff` → Shop | Scan; save retailer ID, storage, shelf price |
| Shopper | scan QR with phone camera | Freshness score, days since harvest, farm origin, handlers, journey, 1–5★ rating |
| Farmer | `/farmer` | Farmer ID + 6-digit key (shown to staff when the batch is created) → where each batch went, prices, scans, ratings |
| Team | `/staff` → Data | Download all data as CSV for your journey log and slides |

## Data (matches Slide 5)
| Table | Fields |
|---|---|
| `batches` (Farm) | batch_id, farmer_id, crop_type, harvest_datetime, farm_lat/farm_lng, quantity_kg, quality_grade |
| `mandi_events` | mandi_id, arrival_timestamp, transport_id, auction_price_per_kg, quality_check_score |
| `retailer_events` | retailer_id, received_timestamp, shelf_price_per_kg, storage_condition, shelf_life_days *(computed)* |
| `scans` (Consumer) | scan_timestamp, days_since_harvest, freshness_score, handler_count *(computed)*, feedback_rating |

**Freshness score** = grade base (A 100, B 92, C 84) − 60 × (age ÷ crop shelf life), blended 70/30 with the mandi quality score. Cold storage doubles shelf life. Shelf lives are in `db.js`.

**Privacy (Slide 9):** shoppers never see auction price or quality score; farmers see only their own batches, protected by their key. Staff pages need the PIN.

## Real-journey evidence for the PPT
Use the real mandi visit for your own batch IDs, then show: label photo (top/side/front), phone showing the journey page, the CSV export for Slide 7.
