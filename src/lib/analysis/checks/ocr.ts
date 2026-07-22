// OCR + Indian number-plate format validation.
//
// We run Tesseract on the original bytes. Tesseract.js is slow but
// dependency-light and works inside a Node.js worker without external
// services. We cap execution time with a timeout — if OCR doesn't return
// within the budget we record a warn rather than failing the whole job.
//
// Once we have text, we attempt to extract a candidate Indian registration
// number using BH-series-aware regexes. The format changed in 2021 to
// include "BH"-series (Bharat series) and the older state-prefix form is
// still in use, so we accept both.
import Tesseract from "tesseract.js";
import { config } from "@/lib/config";
import type { Check, CheckContext, CheckResult } from "../types";

// Accepts e.g. "MH 12 AB 1234", "MH12AB1234", "BH-series "23A1234"". We are
// intentionally permissive — the goal is "does this *look like* a number
// plate", not "is this a real registration".
const PLATE_PATTERNS: { name: string; re: RegExp }[] = [
  // New BH-series: "23AB 1234" or "23AB1234"
  { name: "bh-series", re: /\b\d{2}[A-Z]{2}\s?\d{4}\b/g },
  // Classic state-prefix: "MH12AB1234" / "MH 12 AB 1234" / "TN-99-Z-1234"
  { name: "state-prefix", re: /\b[A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{1,4}\b/g },
  // Diplomatic / temporary plates are out of scope for the assignment.
];

function normaliseForMatch(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, " ");
}

function validatePlateFormat(raw: string): { valid: boolean; reason?: string; normalized: string } {
  const norm = raw.toUpperCase().replace(/\s+/g, "");
  if (norm.length < 7 || norm.length > 11) {
    return { valid: false, reason: "length", normalized: norm };
  }
  // BH-series
  if (/^\d{2}[A-Z]{2}\d{4}$/.test(norm)) return { valid: true, normalized: norm };
  // Classic: 2 letters, 1-2 digits, up to 3 letters, up to 4 digits
  if (/^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}$/.test(norm)) return { valid: true, normalized: norm };
  return { valid: false, reason: "format", normalized: norm };
}

export const ocrCheck: Check = {
  name: "ocr",
  async run(ctx: CheckContext): Promise<CheckResult> {
    let text = "";
    let ocrError: string | null = null;
    try {
      const result = await Promise.race([
        Tesseract.recognize(ctx.buffer, "eng", {
          // Quiet logger — Tesseract's progress messages are noisy.
          logger: () => {},
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ocr-timeout")), config.ocrTimeoutMs),
        ),
      ]);
      text = result.data.text ?? "";
    } catch (err) {
      ocrError = err instanceof Error ? err.message : String(err);
    }

    if (ocrError) {
      return {
        checkName: "ocr",
        verdict: "warn",
        confidence: 0.4,
        details: { error: ocrError, ocrTextLength: 0 },
      };
    }

    const normalised = normaliseForMatch(text);
    const candidates: { raw: string; pattern: string }[] = [];
    for (const p of PLATE_PATTERNS) {
      const matches = normalised.match(p.re) ?? [];
      for (const m of matches) candidates.push({ raw: m, pattern: p.name });
    }

    if (candidates.length === 0) {
      return {
        checkName: "ocr",
        verdict: "warn",
        confidence: 0.7,
        details: {
          ocrText: text.slice(0, 500),
          candidates: [],
          reason: "no plate-shaped text found",
        },
      };
    }

    const validated = candidates.map((c) => ({ ...c, ...validatePlateFormat(c.raw) }));
    const good = validated.find((v) => v.valid);

    if (good) {
      return {
        checkName: "ocr",
        verdict: "pass",
        confidence: 0.85,
        details: {
          ocrText: text.slice(0, 500),
          normalizedPlate: good.normalized,
          pattern: good.pattern,
          candidates: validated,
        },
      };
    }

    return {
      checkName: "ocr",
      verdict: "fail",
      confidence: 0.75,
      details: {
        ocrText: text.slice(0, 500),
        candidates: validated,
        reason: "no candidate passed plate format check",
      },
    };
  },
};
