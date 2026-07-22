// Duplicate detection.
//
// Two layers:
//   1. Exact duplicate via sha256 of bytes. Cheap, perfect.
//   2. Near-duplicate via perceptual hash (dHash, 8x8). Catches re-encodes /
//      resizes of the same photo. We compare against the *most recent N*
//      images — for a real system you'd use a BK-tree or annoy index.
import crypto from "node:crypto";
import { db } from "@/db";
import { images } from "@/db/schema";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Check, CheckContext, CheckResult } from "../types";

// Tiny dHash — easier to validate than pulling in another dep. We use
// sharp-derived grayscale bytes from the context (width/height).
function dHashFromContext(ctx: CheckContext): string {
  // Downsample to 9x8 by averaging blocks in the source. We do this on the
  // already-decoded RGBA buffer we have; it's cheap.
  const w = ctx.width;
  const h = ctx.height;
  if (w < 9 || h < 8) return "";
  const cellW = Math.floor(w / 9);
  const cellH = Math.floor(h / 8);
  const gray: number[] = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 9; c++) {
      let sum = 0;
      let n = 0;
      const x0 = c * cellW;
      const y0 = r * cellH;
      const x1 = Math.min(w, x0 + cellW);
      const y1 = Math.min(h, y0 + cellH);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          sum +=
            0.299 * ctx.buffer[i] +
            0.587 * ctx.buffer[i + 1] +
            0.114 * ctx.buffer[i + 2];
          n++;
        }
      }
      gray.push(sum / Math.max(1, n));
    }
  }
  // 8 rows × 8 comparisons = 64-bit hash.
  let bits = "";
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      bits += gray[r * 9 + c] > gray[r * 9 + c + 1] ? "1" : "0";
    }
  }
  // Convert to hex (16 chars).
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (xor) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

export const duplicateCheck: Check = {
  name: "duplicate",
  async run(ctx: CheckContext): Promise<CheckResult> {
    // 1) exact duplicate by sha256
    const exact = await db
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.sha256, ctx.sha256), ne(images.id, ctx.imageId)))
      .limit(1);

    if (exact.length > 0) {
      return {
        checkName: "duplicate",
        verdict: "fail",
        confidence: 1,
        details: { type: "exact", matchImageId: exact[0].id },
      };
    }

    // 2) near-duplicate by dHash
    const candidates = await db
      .select({ id: images.id, phash: images.phash })
      .from(images)
      .where(ne(images.id, ctx.imageId))
      .orderBy(desc(images.uploadedAt))
      .limit(500);
    const myHash = ctx.phash || dHashFromContext(ctx);
    let best = { id: "", dist: 64 };
    for (const c of candidates) {
      if (!c.phash) continue;
      const d = hammingHex(myHash, c.phash);
      if (d < best.dist) best = { id: c.id, dist: d };
    }
    if (best.dist <= 5) {
      return {
        checkName: "duplicate",
        verdict: "fail",
        confidence: Math.min(1, (5 - best.dist) / 5 + 0.5),
        details: { type: "near", matchImageId: best.id, hammingDistance: best.dist },
      };
    }
    if (best.dist <= 10) {
      return {
        checkName: "duplicate",
        verdict: "warn",
        confidence: 0.6,
        details: { type: "near", matchImageId: best.id, hammingDistance: best.dist },
      };
    }
    return {
      checkName: "duplicate",
      verdict: "pass",
      confidence: 0.8,
      details: { hammingDistance: best.dist, hash: myHash },
    };
  },
};
