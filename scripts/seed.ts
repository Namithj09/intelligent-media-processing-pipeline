// scripts/seed.ts — synthetic-image generator for local testing.
//
// We don't ship real photos (rights + size); instead we generate images
// that exercise the checks: a "sharp" image, a "blurry" image (heavily
// gaussian-blurred), a "dark" image, and a "small" image. We then upload
// them through the running server and print the resulting job ids.
//
// Run with: `npx tsx scripts/seed.ts` (after the server is up).
import sharp from "sharp";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type SharpPipeline = ReturnType<typeof sharp>;
async function makeImage(
  out: string,
  width: number,
  height: number,
  mutate: (pipeline: SharpPipeline) => SharpPipeline,
) {
  // Start with a noisy random image so blur detection has texture to work
  // with. Pure flat colors return 0 Laplacian variance regardless of blur.
  const noise = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noise.length; i++) {
    noise[i] = Math.floor(Math.random() * 256);
  }
  let p = sharp(noise, { raw: { width, height, channels: 3 } });
  p = mutate(p);
  const buf = await p.png().toBuffer();
  writeFileSync(out, buf);
}

async function main() {
  const outDir = path.join(process.cwd(), "storage", "seed");
  mkdirSync(outDir, { recursive: true });

  await makeImage(path.join(outDir, "sharp.png"), 800, 600, (p) => p);
  await makeImage(path.join(outDir, "blurry.png"), 800, 600, (p) =>
    p.blur(20),
  );
  await makeImage(path.join(outDir, "dark.png"), 800, 600, (p) =>
    p.linear(0.05, 0),
  );
  await makeImage(path.join(outDir, "small.png"), 64, 48, (p) => p);
  await makeImage(path.join(outDir, "duplicate.png"), 800, 600, (p) => p);

  const base = process.env.SEED_BASE_URL ?? "http://localhost:3000";
  const fs = await import("node:fs");
  for (const name of [
    "sharp.png",
    "blurry.png",
    "dark.png",
    "small.png",
    "duplicate.png",
    "sharp.png", // re-upload to test exact duplicate
  ]) {
    const file = path.join(outDir, name);
    const form = new FormData();
    const bytes = new Uint8Array(fs.readFileSync(file));
    form.append("file", new Blob([bytes]), name);
    const res = await fetch(`${base}/api/images`, { method: "POST", body: form });
    const j = await res.json();
    console.log(name, "->", j);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
