// In-process job queue with a small worker pool.
//
// Why in-process and not BullMQ/SQS:
//   - The assignment explicitly says the *choice* matters less than the
//     reasoning. Reasoning is in the README.
//   - An in-process queue keeps the assignment runnable with a single
//     `npm run build` and no Redis dependency.
//   - The interface (enqueue / dispatcher / process loop) mirrors what
//     you'd implement against BullMQ, so swapping is a small change.
import { db } from "@/db";
import { jobs, images, analysisResults } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import sharp from "sharp";
import exifr from "exifr";
import crypto from "node:crypto";
import { absolutePathFor, readBuffer } from "@/lib/storage";
import { aggregate } from "./analysis/engine";
import type { Check, CheckContext, CheckResult } from "./analysis/types";

type JobRow = typeof jobs.$inferSelect;
type ImageRow = typeof images.$inferSelect;

let dispatcherStarted = false;
let stopRequested = false;
const inFlight = new Set<string>();
let nextWorkerId = 1;

function nowIso() {
  return new Date();
}

async function buildCheckContext(
  job: JobRow,
  image: ImageRow,
  workerId: string,
): Promise<CheckContext> {
  const abs = absolutePathFor(image.storagePath);
  const buf = await readBuffer(abs);
  // Decode with sharp. We downscale to keep CPU bounded: most checks work
  // fine on a 1024px-wide image, and we want predictable latency.
  const MAX_DIM = 1280;
  const meta = await sharp(buf).metadata();
  let pipeline = sharp(buf).rotate(); // honour EXIF orientation
  if ((meta.width ?? 0) > MAX_DIM || (meta.height ?? 0) > MAX_DIM) {
    pipeline = pipeline.resize({
      width: MAX_DIM,
      height: MAX_DIM,
      fit: "inside",
    });
  }
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // EXIF — only the fields we care about. Parsing all of EXIF is wasteful.
  let exif: Record<string, unknown> | null = null;
  try {
    const parsed = await exifr.parse(buf, {
      tiff: true,
      ifd0: { pick: ["Make", "Model", "Software"] },
      exif: { pick: ["DateTimeOriginal", "CreateDate", "ModifyDate"] },
      gps: false,
    });
    if (parsed && typeof parsed === "object") exif = parsed as Record<string, unknown>;
  } catch (err) {
    logger.warn("exif_parse_failed", {
      jobId: job.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  const baseCtx: CheckContext = {
    imageId: image.id,
    jobId: job.id,
    workerId,
    buffer: data,
    width: info.width,
    height: info.height,
    phash: image.phash ?? "",
    sha256: image.sha256,
    exif,
    mimeType: image.mimeType,
  };
  // Stash the original (un-resized) bytes on a side channel so the OCR
  // check can use them. We do this with a non-enumerable property and a
  // cast at use-site to keep CheckContext's type clean.
  Object.defineProperty(baseCtx, "originalBuffer", {
    value: buf,
    enumerable: false,
    writable: false,
  });
  return baseCtx;
}

async function processJob(job: JobRow): Promise<void> {
  const workerId = job.workerId ?? "w?";
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    logger.info(msg, { jobId: job.id, imageId: job.imageId, workerId, ...extra });
  log("job_start", { attempts: job.attempts });
  try {
    const [image] = await db
      .select()
      .from(images)
      .where(eq(images.id, job.imageId))
      .limit(1);
    if (!image) throw new Error("image not found");

    const ctx = await buildCheckContext(job, image, workerId);

    // Run each check; persist incrementally. The OCR check is a special
    // case: it works better on the original (un-resized) bytes, so we
    // give it a swapped buffer.
    const { ocrCheck } = await import("./analysis/checks/ocr");
    const { ALL_CHECKS } = await import("./analysis/engine");
    const otherChecks: Check[] = ALL_CHECKS.filter((c) => c.name !== "ocr");
    const perCheck: CheckResult[] = [];
    for (const c of otherChecks) {
      try {
        const r = await c.run(ctx);
        perCheck.push(r);
        await db.insert(analysisResults).values({
          id: crypto.randomUUID(),
          jobId: job.id,
          checkName: r.checkName,
          verdict: r.verdict,
          confidence: String(r.confidence),
          details: r.details ?? null,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("check_failed", { jobId: job.id, check: c.name, err: msg });
        const fallback: CheckResult = {
          checkName: c.name,
          verdict: "warn",
          confidence: 0,
          details: { error: msg },
        };
        perCheck.push(fallback);
        await db.insert(analysisResults).values({
          id: crypto.randomUUID(),
          jobId: job.id,
          checkName: c.name,
          verdict: "warn",
          confidence: "0",
          details: { error: msg },
        });
      }
    }

    // OCR last so a slow OCR doesn't delay the other checks' persistence.
    try {
      const ocrCtx = {
        ...ctx,
        buffer: (ctx as unknown as { originalBuffer: Buffer }).originalBuffer,
      } as CheckContext;
      const r = await ocrCheck.run(ocrCtx);
      perCheck.push(r);
      await db.insert(analysisResults).values({
        id: crypto.randomUUID(),
        jobId: job.id,
        checkName: r.checkName,
        verdict: r.verdict,
        confidence: String(r.confidence),
        details: r.details ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("check_failed", { jobId: job.id, check: "ocr", err: msg });
      const fallback: CheckResult = {
        checkName: "ocr",
        verdict: "warn",
        confidence: 0,
        details: { error: msg },
      };
      perCheck.push(fallback);
      await db.insert(analysisResults).values({
        id: crypto.randomUUID(),
        jobId: job.id,
        checkName: "ocr",
        verdict: "warn",
        confidence: "0",
        details: { error: msg },
      });
    }

    const overall = aggregate(perCheck);
    const issues = perCheck
      .filter((r) => r.verdict !== "pass")
      .map((r) => `${r.checkName}:${r.verdict}`);

    await db
      .update(jobs)
      .set({
        status: "completed",
        finishedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(eq(jobs.id, job.id));
    log("job_completed", { overall, issues });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("job_failed", { err: msg, attempts: job.attempts });
    const shouldRetry = job.attempts < job.maxAttempts;
    if (shouldRetry) {
      await db
        .update(jobs)
        .set({
          status: "pending",
          error: msg,
          updatedAt: nowIso(),
        })
        .where(eq(jobs.id, job.id));
    } else {
      await db
        .update(jobs)
        .set({
          status: "failed",
          error: msg,
          finishedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(eq(jobs.id, job.id));
    }
  } finally {
    inFlight.delete(job.id);
  }
}

async function pickNextPending(): Promise<JobRow | null> {
  // In a single-process worker, ordering + status filter is enough. A
  // multi-process deployment would use SELECT ... FOR UPDATE SKIP LOCKED.
  const rows = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "pending"))
    .orderBy(asc(jobs.createdAt))
    .limit(1);
  if (rows.length === 0) return null;
  const job = rows[0];
  const updated = await db
    .update(jobs)
    .set({
      status: "processing",
      startedAt: nowIso(),
      attempts: job.attempts + 1,
      workerId: `w${nextWorkerId++}`,
      updatedAt: nowIso(),
    })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "pending")))
    .returning();
  return updated[0] ?? null;
}

async function tick() {
  while (inFlight.size >= config.maxConcurrency) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const job = await pickNextPending();
  if (!job) return false;
  inFlight.add(job.id);
  // Fire-and-forget: we don't await so the loop can keep picking jobs.
  processJob(job).catch((err) =>
    logger.error("processJob_unhandled", {
      jobId: job.id,
      err: err instanceof Error ? err.message : String(err),
    }),
  );
  return true;
}

export function startQueueDispatcher() {
  if (dispatcherStarted) return;
  dispatcherStarted = true;
  stopRequested = false;
  logger.info("queue_dispatcher_start", { maxConcurrency: config.maxConcurrency });
  const loop = async () => {
    while (!stopRequested) {
      try {
        const picked = await tick();
        if (!picked) {
          await new Promise((r) => setTimeout(r, config.pollIntervalMs));
        }
      } catch (err) {
        logger.error("queue_tick_error", {
          err: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, config.pollIntervalMs));
      }
    }
    logger.info("queue_dispatcher_stop");
  };
  loop().catch((err) =>
    logger.error("queue_loop_crashed", {
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}

export function stopQueueDispatcher() {
  stopRequested = true;
}
