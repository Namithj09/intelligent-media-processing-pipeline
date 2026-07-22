// Centralized config + small env helpers. Keeping these in one place makes it
// obvious what the system is configurable on and avoids magic strings.
import path from "node:path";

export const config = {
  storageDir:
    process.env.STORAGE_DIR ?? path.join(process.cwd(), "storage", "uploads"),
  // Concurrency cap on the in-process worker pool. In a real deployment this
  // would be replaced by a real queue (BullMQ/SQS), but the abstraction is
  // the same.
  maxConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  // Max processing attempts before a job is marked failed.
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3),
  // Polling interval for the in-process queue dispatcher.
  pollIntervalMs: Number(process.env.QUEUE_POLL_MS ?? 500),
  // Soft caps to keep uploads bounded.
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  // Tesseract timeout — OCR is the slowest check and we want to fail fast.
  ocrTimeoutMs: Number(process.env.OCR_TIMEOUT_MS ?? 20_000),
};

export function ensureStorageDir() {
  // We lazily create on first write so a cold start in a fresh container
  // doesn't error before any uploads.
  const fs = require("node:fs") as typeof import("node:fs");
  fs.mkdirSync(config.storageDir, { recursive: true });
}
