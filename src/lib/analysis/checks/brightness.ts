// Brightness / low-light check.
//
// We compute mean luma and a clipped-pixel ratio (very dark or very bright
// pixels). Field photos of vehicles are frequently taken at night, in
// parking garages, or in direct sun — all of which the system should flag
// for human review.
import type { Check, CheckContext, CheckResult } from "../types";

export const brightnessCheck: Check = {
  name: "brightness",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const px = ctx.buffer;
    const stride = 4;
    let sum = 0;
    let count = 0;
    let dark = 0;
    let bright = 0;
    for (let i = 0; i < px.length; i += stride) {
      // Rec. 601 luma. Cheap and good enough for a heuristic.
      const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      sum += y;
      if (y < 25) dark++;
      if (y > 230) bright++;
      count++;
    }
    const meanLuma = sum / count;
    const darkRatio = dark / count;
    const brightRatio = bright / count;
    let verdict: CheckResult["verdict"] = "pass";
    let confidence = 1;
    if (meanLuma < 40 || darkRatio > 0.6) {
      verdict = "fail";
      confidence = 0.85;
    } else if (meanLuma < 80 || darkRatio > 0.4) {
      verdict = "warn";
      confidence = 0.7;
    } else if (brightRatio > 0.4 || meanLuma > 220) {
      verdict = "warn";
      confidence = 0.7;
    }
    return {
      checkName: "brightness",
      verdict,
      confidence,
      details: { meanLuma, darkRatio, brightRatio },
    };
  },
};
