// Types describing the analysis engine.
//
// Design intent:
//   - Each check is an independent, pure(ish) function that takes the image
//     buffer + already-extracted signals and returns a verdict + confidence.
//   - The engine runs all checks and persists each result. We deliberately
//     DO NOT short-circuit on first failure — partial information is more
//     useful than no information for an upstream reviewer.

export type Verdict = "pass" | "warn" | "fail";

export interface CheckContext {
  imageId: string;
  jobId: string;
  workerId: string;
  // Original bytes — needed by EXIF parser and OCR.
  buffer: Buffer;
  // Pre-decoded raw pixels (RGBA) + dimensions from sharp.
  width: number;
  height: number;
  // Pre-computed perceptual hash.
  phash: string;
  // sha256 of the bytes.
  sha256: string;
  // EXIF subset we extracted up-front.
  exif: Record<string, unknown> | null;
  // Storage path / mime for debugging fields.
  mimeType: string;
}

export interface CheckResult {
  checkName: string;
  verdict: Verdict;
  // 0..1 confidence. Confidence is NOT a probability that the check is
  // correct — it's a measure of how far the signal was from the threshold
  // boundary. Closer to 0.5 means more uncertain; closer to 0 or 1 means
  // more confident.
  confidence: number;
  details?: Record<string, unknown>;
}

export interface Check {
  name: string;
  run(ctx: CheckContext): Promise<CheckResult>;
}
