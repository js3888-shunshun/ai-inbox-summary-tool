import { z } from "zod";
import type { Digest } from "./summarizer.js";

/** Boundary #3 of the AI seam: deterministically parse + validate model output. */
const ModelOutputSchema = z.object({
  headline: z.string().min(1),
  body: z.string().min(1),
});

/**
 * Extract the JSON object from raw model text. Tolerant of accidental ```json
 * fences or leading/trailing prose by slicing to the outermost braces.
 */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in model output");
  }
  return candidate.slice(start, end + 1);
}

export function parseDigest(raw: string, messageCount: number): Digest {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch (e) {
    throw new Error(`Failed to parse model output as JSON: ${(e as Error).message}`);
  }
  const parsed = ModelOutputSchema.parse(json);
  return { headline: parsed.headline, body: parsed.body, messageCount };
}
