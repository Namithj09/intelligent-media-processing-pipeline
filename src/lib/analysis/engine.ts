// Analysis engine — wires checks together and computes an overall verdict.
//
// Overall verdict aggregation rule (documented in README):
//   - If any check verdict is "fail" with confidence >= 0.7, overall = "fail".
//   - Else if any check verdict is "fail" or >= 2 checks are "warn" with
//     confidence >= 0.5, overall = "warn".
//   - Else "pass".
//
// This is intentionally not a weighted average — for an upstream reviewer
// a hard fail on any one check should pull attention, not get averaged away.
import type { CheckResult, Verdict } from "./types";
import { blurCheck } from "./checks/blur";
import { brightnessCheck } from "./checks/brightness";
import { dimensionsCheck } from "./checks/dimensions";
import { duplicateCheck } from "./checks/duplicate";
import { ocrCheck } from "./checks/ocr";
import { screenshotCheck } from "./checks/screenshot";
import { tamperingCheck } from "./checks/tampering";
import type { Check } from "./types";

export const ALL_CHECKS: Check[] = [
  dimensionsCheck,
  blurCheck,
  brightnessCheck,
  duplicateCheck,
  screenshotCheck,
  tamperingCheck,
  ocrCheck,
];

export function aggregate(
  results: { verdict: Verdict; confidence: number }[],
): { verdict: Verdict; confidence: number } {
  const fails = results.filter((r) => r.verdict === "fail");
  const warns = results.filter((r) => r.verdict === "warn");
  const highConfFail = fails.find((f) => f.confidence >= 0.7);
  if (highConfFail) {
    return { verdict: "fail", confidence: highConfFail.confidence };
  }
  if (fails.length > 0 || warns.filter((w) => w.confidence >= 0.5).length >= 2) {
    const confs = [...fails, ...warns].map((r) => r.confidence);
    const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
    return { verdict: "warn", confidence: avg };
  }
  return { verdict: "pass", confidence: 0.9 };
}

export type { CheckResult };
