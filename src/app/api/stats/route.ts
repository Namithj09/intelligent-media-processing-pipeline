// GET /api/stats — small aggregate for the dashboard. Kept as a separate
// route so the dashboard can poll cheap summary numbers without pulling
// every job.
import { NextResponse } from "next/server";
import { db } from "@/db";
import { jobs, analysisResults, images } from "@/db/schema";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [jobCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(jobs);
  const [imageCount] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(images);
  const [byStatus] = await db
    .select({
      pending: sql<number>`count(*) filter (where status='pending')::int`,
      processing: sql<number>`count(*) filter (where status='processing')::int`,
      completed: sql<number>`count(*) filter (where status='completed')::int`,
      failed: sql<number>`count(*) filter (where status='failed')::int`,
    })
    .from(jobs);
  const byCheck = await db
    .select({
      checkName: analysisResults.checkName,
      total: sql<number>`count(*)::int`,
      pass: sql<number>`count(*) filter (where verdict='pass')::int`,
      warn: sql<number>`count(*) filter (where verdict='warn')::int`,
      fail: sql<number>`count(*) filter (where verdict='fail')::int`,
    })
    .from(analysisResults)
    .groupBy(analysisResults.checkName);
  return NextResponse.json({
    totals: {
      jobs: Number(jobCount?.c ?? 0),
      images: Number(imageCount?.c ?? 0),
    },
    byStatus: {
      pending: Number(byStatus?.pending ?? 0),
      processing: Number(byStatus?.processing ?? 0),
      completed: Number(byStatus?.completed ?? 0),
      failed: Number(byStatus?.failed ?? 0),
    },
    byCheck: byCheck.map((r) => ({
      checkName: r.checkName,
      total: Number(r.total),
      pass: Number(r.pass),
      warn: Number(r.warn),
      fail: Number(r.fail),
    })),
  });
}
