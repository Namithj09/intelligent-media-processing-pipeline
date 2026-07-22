# Vehicle Image Processing Pipeline

A backend service that accepts uploaded vehicle images, processes them
asynchronously, and reports back a structured set of "issue" verdicts —
blur, low light, duplicates, screenshots, suspicious editing, and Indian
number-plate OCR / format validation.

Built as a take-home assignment. Built on Next.js 16 (App Router),
PostgreSQL via Drizzle ORM, with `sharp` for image decoding, `tesseract.js`
for OCR, and `exifr` for metadata.

---

## 1. Quick start

### Option A — local

```bash
# 1. Postgres on localhost:5432, user/pass postgres/postgres, db app_db
cp .env .env.local  # if you want to override
npm install
npx drizzle-kit push   # creates the tables
npm run build
npm start              # http://localhost:3000
```

### Option B — Docker Compose

```bash
docker compose up --build
# wait for "queue_dispatcher_start" in the app logs
# open http://localhost:3000
```

### Seed sample images

```bash
# in another terminal, after the server is up:
npx tsx scripts/seed.ts
# this synthesizes 5 images (sharp, blurry, dark, small, duplicate)
# and uploads them, then re-uploads the sharp one to test exact-dup
```

### Smoke test

```bash
./scripts/test-local.sh
```

---

## 2. API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/images` | Upload an image. Multipart `file` field. Returns `{ jobId, imageId, status: "pending", sha256, sizeBytes }` with HTTP 202. |
| `GET`  | `/api/images` | List all jobs (for the dashboard). |
| `GET`  | `/api/images/:id/file` | Stream the original bytes back. Used for thumbnail rendering. |
| `GET`  | `/api/jobs/:id` | Status + per-check results + overall verdict. |
| `GET`  | `/api/stats` | Aggregate counts for the dashboard. |
| `GET`  | `/api/health` | Liveness + DB ping. |

### Example: upload

```bash
curl -X POST http://localhost:3000/api/images \
  -F "file=@/path/to/photo.jpg"
```

```json
{
  "jobId": "5b9a...uuid",
  "imageId": "0c1e...uuid",
  "status": "pending",
  "sha256": "9b74...",
  "sizeBytes": 482113
}
```

### Example: poll job

```bash
curl http://localhost:3000/api/jobs/<jobId>
```

```json
{
  "jobId": "...",
  "imageId": "...",
  "status": "completed",
  "attempts": 1,
  "maxAttempts": 3,
  "workerId": "w3",
  "overall": { "verdict": "warn", "confidence": 0.72 },
  "image": {
    "originalFilename": "photo.jpg",
    "mimeType": "image/jpeg",
    "sizeBytes": 482113,
    "width": 1920,
    "height": 1080,
    "sha256": "...",
    "phash": "a1b2c3..."
  },
  "checks": [
    { "name": "dimensions", "verdict": "pass", "confidence": 0.95, "details": { "width": 1920, "height": 1080, "ratio": 1.78 } },
    { "name": "blur",       "verdict": "fail", "confidence": 0.92, "details": { "laplacianVariance": 18.4 } },
    { "name": "brightness", "verdict": "pass", "confidence": 0.81, "details": { "meanLuma": 142, "darkRatio": 0.04, "brightRatio": 0.01 } },
    { "name": "duplicate",  "verdict": "pass", "confidence": 0.8,  "details": { "hammingDistance": 27, "hash": "a1b2..." } },
    { "name": "screenshot", "verdict": "pass", "confidence": 0.7,  "details": { "score": 0.0, "reasons": [] } },
    { "name": "tampering",  "verdict": "pass", "confidence": 0.9,  "details": { "score": 0.0, "reasons": [] } },
    { "name": "ocr",        "verdict": "pass", "confidence": 0.85, "details": { "normalizedPlate": "MH12AB1234", "pattern": "state-prefix" } }
  ]
}
```

---

## 3. Architecture

### Service flow

```
              ┌──────────────────┐
  client ──▶  │ POST /api/images │ ──▶ write to disk (sha256-keyed)
              └────────┬─────────┘
                       │ insert images row (+ unique on sha256)
                       │ insert jobs row (status=pending)
                       ▼
              ┌──────────────────┐
              │ in-process queue │ ──▶ poll every 500ms
              │ (max N concurrent)│
              └────────┬─────────┘
                       │ claim a job (status: pending → processing)
                       ▼
              ┌──────────────────┐
              │  worker process  │ ──▶ decode (sharp) → run checks
              │                  │     persist each result, then mark
              │                  │     job completed / failed
              └──────────────────┘

              client ──▶ GET /api/jobs/:id  ──▶ returns status + per-check
              client ──▶ GET /api/stats     ──▶ counts (cheap polling)
```

### Processing flow inside a worker

1. **Claim** — `pickNextPending` selects the oldest `pending` job and
   atomically flips it to `processing` (single-process queue, so the
   status update is enough; production would use `SELECT ... FOR UPDATE
   SKIP LOCKED`).
2. **Decode** — `sharp` reads the file and gives us raw RGBA bytes. We
   downscale to a 1280px cap so checks are O(1.6 MP) at most. EXIF
   orientation is honoured so rotated phone photos are upright.
3. **EXIF** — `exifr` extracts `Make`, `Model`, `Software`, and the
   relevant date fields. Failures here are non-fatal; we proceed with
   `exif = null`.
4. **Run checks** — Each check is an independent async function. They
   are run sequentially (most are sub-100ms; OCR is the outlier and
   runs last with a timeout).
5. **Persist incrementally** — Each check result is written to
   `analysis_results` as it completes, so partial signal survives a
   worker crash.
6. **Aggregate** — An overall verdict is computed from the per-check
   rows (see "Aggregation" below).
7. **Mark completed** — Job flips to `completed` (or `failed` after
   `maxAttempts`).

### Queue strategy

- **In-process** with a small worker pool (default 2, set via
  `WORKER_CONCURRENCY`). The `enqueue` step is just an `INSERT … status='pending'`.
- A polling dispatcher reads pending jobs and flips them to
  `processing` itself, so no separate worker process is required.
- **Retry**: a job that throws is returned to `pending` until
  `attempts >= maxAttempts`, at which point it goes to `failed`. The
  last error message is stored in the `error` column.
- **Why not BullMQ/SQS?** The assignment is single-binary. The
  abstraction (a poll loop over a status column) is the same one
  BullMQ exposes, so swapping is a one-file change to the dispatcher.

### Aggregation

Per-check verdicts are tri-state (`pass` / `warn` / `fail`) with a
0–1 confidence. The overall verdict is:

- `fail` — any check is `fail` with confidence ≥ 0.7
- `warn` — otherwise, if any `fail` exists, **or** ≥ 2 `warn`s have
  confidence ≥ 0.5
- `pass` — otherwise

A weighted average was deliberately not used: a hard fail on a single
check should pull attention, not get averaged away.

---

## 4. The checks

| Check | What it does | Why |
| --- | --- | --- |
| `dimensions` | Rejects tiny images, flags extreme aspect ratios | Plate OCR needs a minimum resolution. Cropped UI screenshots often have weird ratios. |
| `blur` | Laplacian variance on the luma channel | Cheap, dependency-free, classic. Tri-state with a "soft" band. |
| `brightness` | Mean luma + dark/bright pixel ratio | Catches low-light and overexposed field photos. |
| `duplicate` | sha256 exact + dHash hamming-distance | Exact dupes are free; near-duplicates are approximate. |
| `screenshot` | Software tag, missing EXIF on JPEG, row-uniformity heuristic | Screenshots of photos look superficially fine; UI-band signature helps. |
| `tampering` | Software tag for editors, missing camera info | Editor strings + stripped EXIF are weak but defensible signals. |
| `ocr` | Tesseract.js with a timeout, then regex validation against Indian formats (BH-series + classic state-prefix) | Tesseract is slow and noisy, so we cap it; we surface the raw text in `details` for debugging. |

Each check is a single file under `src/lib/analysis/checks/`. They all
implement the same `Check` interface (`name` + `run(ctx)`), so adding
a new one is two files and one entry in `ALL_CHECKS`.

---

## 5. AI usage disclosure

**Where I used AI**

- Initial scaffolding of the Next.js route handler / Drizzle schema.
- Drafting the Tesseract timeout wrapper and the dHash implementation
  (then I rewrote it inline because the AI suggestion pulled in an
  extra dependency).
- README drafting.

**Where AI output was wrong**

- The first Tesseract example I got from a model passed the entire
  image; the model didn't mention that Tesseract does its own internal
  scaling, so I was about to add a redundant pre-scaling step. I
  removed it after reading the docs.
- A generated `dHash` implementation used `crypto` for the bit packing
  (overkill) and had an off-by-one in the comparison loop. Rewrote by
  hand.
- An AI-suggested `exifr` config used `ifd0: false` — the library
  actually requires `ifd0` (it cannot be disabled per the type
  definitions), and it threw at runtime. Fixed by leaving it enabled
  with a `pick`.

**How I validated**

- `npx tsc --noEmit` after every meaningful change.
- I `console.log`'d per-check inputs/outputs during development and
  compared against the seeded `sharp` / `blurry` / `dark` / `small`
  images to confirm verdicts were sensible.
- The seeded images deliberately exercise boundary cases (tiny 64×48
  image → fail on `dimensions`; blurred → fail on `blur`; dark → fail
  on `brightness`).

---

## 6. Trade-offs

### What I intentionally simplified

- **In-process queue.** Right call for a single-binary assignment. A
  production deployment would put the worker in its own process and
  back it with BullMQ + Redis so the API can scale horizontally.
- **Tesseract.js in-process.** Realistic alternative is AWS Textract /
  Google Document AI. Tesseract.js is slow and a little flakey on
  small plates, but it has no external dependency and runs in the same
  Node process.
- **No deduplication for OCR retry.** If OCR returns garbled text and
  a high-confidence fail, we don't currently try a different Tesseract
  config. Adding it would be a one-method change in `ocr.ts`.
- **Heuristics, not ML.** The assignment is explicit that perfect ML
  accuracy is not the goal. Real tampering detection needs PRNU / ELA
  / frequency-domain work; we surface the editable signals and
  document the gap.
- **Polling instead of long-poll / SSE.** The dashboard polls every
  2s. SSE on `/api/jobs/:id` would be a better UX for many concurrent
  users.
- **No auth / rate limiting.** Not in scope. The README and the
  routing are set up so adding a middleware is straightforward.

### What I would improve with more time

- Background-job dedup keyed on `(imageId, checkName)` so re-processing
  an image doesn't recompute unchanged checks.
- Per-check timeout and per-check retry, separately from the job-level
  retry that exists today.
- Real PRNU-based tampering detection. Currently we only look at
  metadata strings.
- A small unit test suite for the heuristics (e.g. synthetic
  Laplacian-variance input → expected verdict). Right now the
  validation is the seeded images + eyeball.
- A worker Dockerfile separate from the API Dockerfile so they can
  scale independently.
- An SSE channel on the dashboard so it doesn't have to poll.

### Scalability concerns

- The duplicate-check query is a linear scan of the last 500 images'
  hashes. At > 500 uploads/hour this is the bottleneck. The right
  replacement is a BK-tree or an `annoy` index in Postgres, or
  pre-computing Hamming buckets in a column.
- The dispatcher polls the DB every 500ms. At very high throughput
  you'd want LISTEN/NOTIFY or a real queue.
- Sharp + Tesseract together are CPU-heavy. Worker concurrency should
  be sized to the number of cores; the current `WORKER_CONCURRENCY`
  env makes that explicit.

### Failure handling

- Worker exceptions during check execution are caught and recorded as
  a `warn` with `confidence: 0` so the job still completes with
  partial signal.
- The OCR check has a hard timeout (`OCR_TIMEOUT_MS`, default 20s)
  so it can't stall the worker pool.
- Job-level errors are retried up to `MAX_ATTEMPTS` (default 3) and
  the last error is stored in the `error` column for `/api/jobs/:id`.

---

## 7. Project layout

```
src/
  app/
    api/
      health/route.ts
      images/route.ts             # POST upload, GET list
      images/[id]/file/route.ts   # GET original bytes
      jobs/[id]/route.ts          # GET status + results
      stats/route.ts              # GET aggregates
    page.tsx                      # dashboard
    layout.tsx
  db/
    schema.ts                     # images, jobs, analysis_results
    index.ts
  lib/
    config.ts
    logger.ts
    storage.ts                    # sha256-keyed FS storage
    queue.ts                      # in-process dispatcher + worker
    bootstrap.ts                  # lazy start
    analysis/
      types.ts                    # Check / CheckContext / Verdict
      engine.ts                   # aggregation + persistence
      checks/
        blur.ts
        brightness.ts
        dimensions.ts
        duplicate.ts
        ocr.ts
        screenshot.ts
        tampering.ts
scripts/
  seed.ts                         # synthesizes & uploads test images
  test-local.sh                   # smoke test
Dockerfile
docker-compose.yml
drizzle.config.json
```

## 8. Running the tests / scripts

```bash
# 1. Build and start
npm run build && npm start &

# 2. Seed
npx tsx scripts/seed.ts

# 3. Smoke test (lists a completed job + stats)
./scripts/test-local.sh
```
#   i n t e l l i g e n t - m e d i a - p r o c e s s i n g - p i p e l i n e  
 