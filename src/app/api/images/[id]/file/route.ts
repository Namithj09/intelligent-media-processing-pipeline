// GET /api/images/:id/file — returns the original stored image bytes. This
// is what the dashboard uses to render the upload thumbnail, and is also
// useful for debugging a job end-to-end.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { images } from "@/db/schema";
import { eq } from "drizzle-orm";
import { absolutePathFor, readBuffer } from "@/lib/storage";
import fs from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const [image] = await db
    .select()
    .from(images)
    .where(eq(images.id, id))
    .limit(1);
  if (!image) {
    return NextResponse.json({ error: "image not found" }, { status: 404 });
  }
  const abs = absolutePathFor(image.storagePath);
  try {
    await fs.access(abs);
  } catch {
    return NextResponse.json(
      { error: "stored file missing" },
      { status: 410 },
    );
  }
  const buf = await readBuffer(abs);
  // Re-wrap into a fresh Uint8Array/ArrayBuffer so the Response BodyInit
  // type is satisfied even if Node returns a SharedArrayBuffer-backed
  // view (which can happen under certain buffer-pool implementations).
  const fresh = new Uint8Array(buf.byteLength);
  fresh.set(buf);
  return new Response(fresh, {
    headers: {
      "content-type": image.mimeType,
      "cache-control": "private, max-age=300",
    },
  });
}
