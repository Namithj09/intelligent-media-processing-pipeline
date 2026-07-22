// Screenshot / photo-of-photo heuristic.
//
// There is no perfect way to tell a screenshot apart from a photo — both are
// just pixel arrays. What we *can* detect with reasonable confidence:
//   - A high proportion of near-identical pixels arranged in horizontal/vertical
//     bands (typical of UI: status bar, address bar, content, tab bar)
//   - Very large uniform color regions (UI background)
//   - EXIF software tags like "Snipping Tool", "Screenshot", "Pixel"
//
// We combine those into a single score. This is intentionally a *heuristic*
// — the docs/README are explicit that ML accuracy is not the goal.
import type { Check, CheckContext, CheckResult } from "../types";

function horizontalBandUniformity(pixels: Buffer, width: number, height: number) {
  // For each row, compute the stddev of pixel intensity. A photo of a real
  // scene has high stddev in nearly every row. A screenshot has wide flat
  // bands (white app background, address bar, etc.).
  const stride = width * 4;
  const rowScores: number[] = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    let sumSq = 0;
    const n = width;
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * 4;
      const l = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      sum += l;
      sumSq += l * l;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    rowScores.push(Math.sqrt(Math.max(0, variance)));
  }
  // Count "flat" rows (low stddev) and "busy" rows (high stddev).
  const flat = rowScores.filter((s) => s < 5).length;
  const busy = rowScores.filter((s) => s > 40).length;
  return {
    flatRatio: flat / rowScores.length,
    busyRatio: busy / rowScores.length,
  };
}

const SCREENSHOT_SOFTWARE_TAGS = [
  "snipping",
  "screenshot",
  "snip & sketch",
  "pixel",
  "ios",
  "android",
];

export const screenshotCheck: Check = {
  name: "screenshot",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const reasons: string[] = [];
    let score = 0;

    // 1) Software tag.
    const software = (ctx.exif?.Software as string | undefined) ?? "";
    const lower = software.toLowerCase();
    for (const tag of SCREENSHOT_SOFTWARE_TAGS) {
      if (lower.includes(tag)) {
        score += 0.6;
        reasons.push(`software:${tag}`);
        break;
      }
    }

    // 2) EXIF tells us whether this came out of a real camera. If there's
    //    NO exif at all but the file claims to be a JPEG, it's suspicious.
    if (!ctx.exif || Object.keys(ctx.exif).length === 0) {
      if (ctx.mimeType === "image/jpeg") {
        score += 0.2;
        reasons.push("no-exif-on-jpeg");
      }
    }

    // 3) Row-uniformity heuristic.
    const { flatRatio, busyRatio } = horizontalBandUniformity(
      ctx.buffer,
      ctx.width,
      ctx.height,
    );
    if (flatRatio > 0.3 && busyRatio < 0.2) {
      score += 0.4;
      reasons.push(`flat-rows:${flatRatio.toFixed(2)}`);
    }

    score = Math.min(1, score);
    let verdict: CheckResult["verdict"] = "pass";
    let confidence = 1 - score;
    if (score >= 0.7) {
      verdict = "fail";
      confidence = score;
    } else if (score >= 0.4) {
      verdict = "warn";
      confidence = 0.6;
    } else {
      verdict = "pass";
      confidence = 1 - score;
    }
    return {
      checkName: "screenshot",
      verdict,
      confidence,
      details: { score, reasons, flatRatio, busyRatio, software },
    };
  },
};
