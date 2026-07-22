// Blur detection using the variance of the Laplacian.
//
// Why this works: a sharp image has strong local intensity gradients; when
// you convolve it with a Laplacian kernel the response has high variance.
// A blurry image is locally smooth, so the Laplacian response collapses and
// variance drops.
//
// Thresholding is intentionally conservative — we want a "warn" band for
// borderline cases rather than a hard fail, because field photos taken
// through windshields are often slightly soft.
import type { Check, CheckContext, CheckResult } from "../types";

function laplacianVariance(pixels: Buffer, width: number, height: number) {
  // 4-neighbour Laplacian. We work on the luma channel only — color
  // information doesn't help here and grayscale is faster.
  // Input pixels: RGBA, 4 bytes per pixel.
  const stride = width * 4;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * stride + x * 4;
      const c = pixels[i]; // R channel as luminance proxy
      const up = pixels[i - stride];
      const down = pixels[i + stride];
      const left = pixels[i - 4];
      const right = pixels[i + 4];
      const v = up + down + left + right - 4 * c;
      sum += v;
      sumSq += v * v;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

export const blurCheck: Check = {
  name: "blur",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const v = laplacianVariance(ctx.buffer, ctx.width, ctx.height);
    // Empirically:
    //   < 50   => very blurry, almost certainly a problem
    //   50-150 => soft / suspect
    //   > 150  => sharp
    // These numbers will be wrong for different camera sensors; the right
    // move in production is to learn thresholds from labelled data.
    let verdict: CheckResult["verdict"] = "pass";
    let confidence = 1;
    if (v < 50) {
      verdict = "fail";
      confidence = 0.9;
    } else if (v < 150) {
      verdict = "warn";
      confidence = 0.7;
    } else {
      verdict = "pass";
      confidence = Math.min(1, v / 500);
    }
    return {
      checkName: "blur",
      verdict,
      confidence,
      details: { laplacianVariance: v },
    };
  },
};
