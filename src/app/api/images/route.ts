// POST /api/images — upload an image and enqueue a processing job.
//
// The flow is:
//   1. Read the multipart body. Accept either a `file` field or a single
//      raw body. We do not stream-to-disk from the request directly because
//      Next.js route handlers receive a fully-buffered Request; reading the
//      ArrayBuffer once is fine.
//   2. Validate MIME + size.
//   3. Persist to local storage, computing sha256 + perceptual hash.
//   4. Insert an `images` row. The unique index on sha256 means re-uploading
//      the *exact* same bytes reuses the same image record (we still create
//      a new job so re-processing is possible).
//   5. Insert a `jobs` row in `pending` state.
//   6. Return the job id + image id + status.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { images, jobs } from "@/db/schema";
import { config, ensureStorageDir } from "@/lib/config";
import { ensureBootstrapped } from "@/lib/bootstrap";
import { saveBuffer } from "@/lib/storage";
import { logger } from "@/lib/logger";
import sharp from "sharp";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

async function computePhash(buffer: Buffer): Promise<string> {
  // We compute the dHash on a sharp-downsampled grayscale image. This is
  // separate from the duplicate check's on-the-fly dHash (which is used
  // when phash isn't precomputed) — the stored value is the canonical one.
  const { data, info } = await sharp(buffer)
    .rotate()
    .grayscale()
    .resize({ width: 9, height: 8, fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      bits += data[r * 9 + c] > data[r * 9 + c + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

async function getDimensions(
  buffer: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const m = await sharp(buffer).metadata();
    if (m.width && m.height) return { width: m.width, height: m.height };
  } catch (err) {
    logger.warn("sharp_metadata_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

export async function POST(req: NextRequest) {
  ensureBootstrapped();
  ensureStorageDir();
  const contentType = req.headers.get("content-type") ?? "";
  let buffer: Buffer;
  let originalFilename = "upload.bin";
  let mimeType = "application/octet-stream";

  try {
    if (contentType.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") {
        return NextResponse.json(
          { error: "missing 'file' field" },
          { status: 400 },
        );
      }
      // File extends Blob, has .arrayBuffer() and a name.
      originalFilename = (file as File).name || originalFilename;
      mimeType = (file as File).type || mimeType;
      const ab = await (file as File).arrayBuffer();
      buffer = Buffer.from(ab);
    } else {
      // Treat body as raw bytes.
      const ab = await req.arrayBuffer();
      buffer = Buffer.from(ab);
      mimeType = contentType.split(";")[0].trim() || mimeType;
      originalFilename =
        req.headers.get("x-filename")?.replace(/[^a-zA-Z0-9._-]/g, "_") ||
        `upload.${mimeType.split("/")[1] ?? "bin"}`;
    }
  } catch (err) {
    logger.error("upload_body_read_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "failed to read upload body" },
      { status: 400 },
    );
  }

  if (!ALLOWED_MIME.has(mimeType)) {
    return NextResponse.json(
      { error: `unsupported mime type: ${mimeType}` },
      { status: 415 },
    );
  }
  if (buffer.byteLength === 0) {
    return NextResponse.json({ error: "empty upload" }, { status: 400 });
  }
  if (buffer.byteLength > config.maxUploadBytes) {
    return NextResponse.json(
      { error: `file too large (max ${config.maxUploadBytes} bytes)` },
      { status: 413 },
    );
  }

  // Storage (computes sha256, writes to disk).
  const stored = await saveBuffer(originalFilename, buffer);
  const phash = await computePhash(buffer).catch((err) => {
    logger.warn("phash_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return "";
  });
  const dims = await getDimensions(buffer);

  // Insert image row; if an image with the same sha256 already exists, we
  // reuse it (true dedup).
  let imageId: string;
  const existing = await db
    .select()
    .from(images)
    .where(eq(images.sha256, stored.sha256))
    .limit(1);
  if (existing.length > 0) {
    imageId = existing[0].id;
    // Update phash / dimensions if they were missing.
    if (!existing[0].phash && phash) {
      await db
        .update(images)
        .set({ phash })
        .where(eq(images.id, imageId));
    }
  } else {
    imageId = crypto.randomUUID();
    await db.insert(images).values({
      id: imageId,
      originalFilename,
      storagePath: stored.storagePath,
      mimeType,
      sizeBytes: stored.sizeBytes,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      phash: phash || null,
      sha256: stored.sha256,
    });
  }

  // Enqueue job.
  const jobId = crypto.randomUUID();
  await db.insert(jobs).values({
    id: jobId,
    imageId,
    status: "pending",
    maxAttempts: config.maxAttempts,
  });

  logger.info("image_uploaded", {
    imageId,
    jobId,
    sizeBytes: stored.sizeBytes,
    mimeType,
  });

  return NextResponse.json(
    {
      jobId,
      imageId,
      status: "pending",
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
    },
    { status: 202 },
  );
}

export async function GET() {
  // Convenience listing for the dashboard.
  ensureBootstrapped();
  const rows = await db
    .select()
    .from(jobs)
    .orderBy(jobs.createdAt);
  return NextResponse.json({ count: rows.length, jobs: rows });
}
