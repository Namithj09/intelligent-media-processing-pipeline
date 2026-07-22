// GET /api/jobs/:id
//
// Returns the current job status, the image metadata, and (if available)
// the per-check analysis results aggregated into a structured response.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { jobs, images, analysisResults } from "@/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) {
    return NextResponse.json({ error: "job not found" }, { status: 404 });
  }
  const [image] = await db
    .select()
    .from(images)
    .where(eq(images.id, job.imageId))
    .limit(1);
  const results = await db
    .select()
    .from(analysisResults)
    .where(eq(analysisResults.jobId, id));

  // Aggregate overall verdict from per-check rows.
  const fails = results.filter((r) => r.verdict === "fail");
  const warns = results.filter((r) => r.verdict === "warn");
  let overallVerdict: "pass" | "warn" | "fail" = "pass";
  let overallConfidence = 0.9;
  if (fails.find((f) => Number(f.confidence) >= 0.7)) {
    overallVerdict = "fail";
    overallConfidence = Number(
      fails.find((f) => Number(f.confidence) >= 0.7)!.confidence,
    );
  } else if (
    fails.length > 0 ||
    warns.filter((w) => Number(w.confidence) >= 0.5).length >= 2
  ) {
    overallVerdict = "warn";
    const confs = [...fails, ...warns].map((r) => Number(r.confidence));
    overallConfidence =
      confs.reduce((a, b) => a + b, 0) / Math.max(1, confs.length);
  }

  return NextResponse.json({
    jobId: job.id,
    imageId: job.imageId,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    workerId: job.workerId,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    overall: { verdict: overallVerdict, confidence: overallConfidence },
    image: image
      ? {
          id: image.id,
          originalFilename: image.originalFilename,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          width: image.width,
          height: image.height,
          sha256: image.sha256,
          phash: image.phash,
          uploadedAt: image.uploadedAt,
        }
      : null,
    checks: results.map((r) => ({
      name: r.checkName,
      verdict: r.verdict,
      confidence: Number(r.confidence),
      details: r.details,
      createdAt: r.createdAt,
    })),
  });
}
