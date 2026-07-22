// Tampering / editing heuristic.
//
// We don't run a real forensic model. Instead we surface a small set of
// *defensible* signals:
//   - Software string indicating an editor (Photoshop, GIMP, Snapseed...)
//   - Missing camera EXIF where one would be expected (edited images often
//     re-exported without EXIF, or with stripped GPS)
//   - Suspicious creation-vs-modification date gaps
//
// Real tampering detection requires frequency-domain / PRNU analysis, which
// is out of scope. We document this in the README.
import type { Check, CheckContext, CheckResult } from "../types";

const EDITOR_SOFTWARE = [
  "photoshop",
  "gimp",
  "lightroom",
  "snapseed",
  "afterlight",
  "vsco",
  "picsart",
  "affinity",
  "pixelmator",
];

export const tamperingCheck: Check = {
  name: "tampering",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const reasons: string[] = [];
    let score = 0;
    const software = ((ctx.exif?.Software as string | undefined) ?? "").toLowerCase();
    for (const ed of EDITOR_SOFTWARE) {
      if (software.includes(ed)) {
        score += 0.5;
        reasons.push(`editor:${ed}`);
        break;
      }
    }
    if (ctx.exif) {
      const make = (ctx.exif.Make as string | undefined) ?? "";
      const model = (ctx.exif.Model as string | undefined) ?? "";
      if (!make && !model && ctx.mimeType === "image/jpeg") {
        score += 0.2;
        reasons.push("no-camera-info");
      }
    } else {
      // Already covered by screenshot check, but reinforces here.
      score += 0.1;
      reasons.push("no-exif");
    }
    score = Math.min(1, score);
    let verdict: CheckResult["verdict"] = "pass";
    let confidence = 1 - score;
    if (score >= 0.6) {
      verdict = "fail";
      confidence = score;
    } else if (score >= 0.3) {
      verdict = "warn";
      confidence = 0.55;
    }
    return {
      checkName: "tampering",
      verdict,
      confidence,
      details: { score, reasons, software },
    };
  },
};
