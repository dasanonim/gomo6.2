import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Motion contract guard.
 *
 * The motion language lives in `lib/motion.ts`: a small set of named springs.
 * The point of naming them is that a screen which means "this is a press"
 * uses the same physics as every other press — the moment someone inlines
 * `stiffness: 450`, the language forks, and two surfaces that should feel
 * identical no longer do.
 *
 * So: raw spring numbers and raw `type: "spring"` literals are forbidden
 * outside the presets file. Add a preset instead (and name it by intent).
 */

const ROOT = join(__dirname, "..");
const SELF = join(__dirname, "motion.ts");
const SELF_TEST = join(__dirname, "motion.contract.test.ts");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });

const sources = walk(ROOT).filter(
  (path) => path !== SELF && path !== SELF_TEST && !/\.test\.tsx?$/.test(path),
);

/** Every offending line as `path:line — text`. */
const findViolations = (pattern: RegExp): string[] =>
  sources.flatMap((path) => {
    const hits: string[] = [];
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${relative(ROOT, path)}:${i + 1} — ${line.trim()}`);
      });
    return hits;
  });

describe("motion contract", () => {
  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("uses named spring presets instead of inline physics", () => {
    const violations = findViolations(/\b(stiffness|damping)\s*:/);
    expect(
      violations,
      "Spring numbers must come from SPRING in @/lib/motion.ts — add a preset named by intent.",
    ).toEqual([]);
  });

  it("uses named spring presets instead of raw spring transitions", () => {
    const violations = findViolations(/type:\s*["']spring["']/);
    expect(
      violations,
      "Use SPRING.<preset> (or springFor(preset, reduceMotion)) from @/lib/motion.ts.",
    ).toEqual([]);
  });
});
