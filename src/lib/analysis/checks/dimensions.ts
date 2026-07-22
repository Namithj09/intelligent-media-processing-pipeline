// Dimension / aspect-ratio validation.
//
// Catches a few real failure modes:
//   - tiny images (e.g. 64x64) where number-plate OCR is hopeless
//   - wildly distorted aspect ratios that often indicate a screenshot of
//     a photo, rather than the photo itself
//   - extreme aspect ratios (>3:1) that look like cropped UI
import type { Check, CheckContext, CheckResult } from "../types";

export const dimensionsCheck: Check = {
  name: "dimensions",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const { width, height } = ctx;
    if (!width || !height) {
      return {
        checkName: "dimensions",
        verdict: "fail",
        confidence: 1,
        details: { reason: "missing dimensions" },
      };
    }
    const minSide = Math.min(width, height);
    const maxSide = Math.max(width, height);
    const ratio = maxSide / minSide;
    const details = { width, height, minSide, maxSide, ratio };
    let verdict: CheckResult["verdict"] = "pass";
    let confidence = 1;
    if (minSide < 200) {
      verdict = "fail";
      confidence = 0.9;
    } else if (minSide < 400) {
      verdict = "warn";
      confidence = 0.75;
    } else if (ratio > 3) {
      verdict = "warn";
      confidence = 0.65;
    }
    return { checkName: "dimensions", verdict, confidence, details };
  },
};
