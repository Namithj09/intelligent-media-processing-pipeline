import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Enums ----------------------------------------------------------------------
export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

// Tables ---------------------------------------------------------------------
// An "image" is the canonical record for an uploaded file. We keep image-level
// data (storage path, hashes, metadata) separate from job-level data
// (attempts, status, errors) so that re-processing an image does not lose
// historical signal.
export const images = pgTable(
  "images",
  {
    id: text("id").primaryKey(), // uuid
    originalFilename: text("original_filename").notNull(),
    storagePath: text("storage_path").notNull(), // relative to STORAGE_DIR
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"),
    height: integer("height",

),
    // perceptual hash (16 hex chars) used for near-duplicate detection
    phash: text("phash"),
    // sha256 of file bytes — exact-duplicate detection. Non-null because
    // we compute it at upload time and dedupe on it.
    sha256: text("sha256").notNull(),
    // raw EXIF as JSON (we only keep a small subset to avoid bloat)
    exif: jsonb("exif"),
    // device / software fields useful for tampering heuristics
    software: text("software"),
    createDate: timestamp("create_date", { withTimezone: true }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    shaIdx: uniqueIndex("images_sha256_uq").on(t.sha256),
    phashIdx: index("images_phash_idx").on(t.phash),
  }),
);

// A "job" is a single processing run for an image. We allow multiple jobs
// per image so that re-processing (e.g. after a worker bug) is possible.
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(), // uuid
    imageId: text("image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    status: jobStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    error: text("error"),
    // workerId lets us see which in-process worker picked up the job — useful
    // when debugging concurrency.
    workerId: text("worker_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    imageIdx: index("jobs_image_idx").on(t.imageId),
    statusIdx: index("jobs_status_idx").on(t.status),
  }),
);

// Analysis results — one row per check per job. This lets us:
//   - keep partial results when other checks fail
//   - query/aggregate over time (e.g. "what % of uploads are blurry?")
//   - track confidence per check independently
export const analysisResults = pgTable(
  "analysis_results",
  {
    id: text("id").primaryKey(), // uuid
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    checkName: text("check_name").notNull(),
    // Verdict: "pass" | "warn" | "fail". We use tri-state instead of boolean
    // because most checks are heuristics with a confidence gradient.
    verdict: text("verdict").notNull(),
    // 0..1 — how confident the system is in the verdict.
    confidence: text("confidence").notNull(),
    // Free-form details: extracted text, measured values, etc.
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    jobIdx: index("analysis_results_job_idx").on(t.jobId),
    checkIdx: index("analysis_results_check_idx").on(t.checkName),
  }),
);

export type Image = typeof images.$inferSelect;
export type NewImage = typeof images.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type AnalysisResult = typeof analysisResults.$inferSelect;
export type NewAnalysisResult = typeof analysisResults.$inferInsert;
