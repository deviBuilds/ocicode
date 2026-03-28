import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

const ALLOWED_PATHS = new Set(["bun.lock", "scripts/no-telemetry.test.ts"]);

const FORBIDDEN_SOURCE_PATTERNS = [
  "AnalyticsService",
  "OCICODE_TELEMETRY_",
  "OCICODE_POSTHOG_",
  "server.boot.heartbeat",
  "anonymous-id",
] as const;

function walk(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    const relativePath = path.relative(repoRoot, absolutePath);

    if (
      entry.name === "node_modules" ||
      entry.name === ".git" ||
      entry.name === ".turbo" ||
      entry.name === ".astro" ||
      entry.name === "dist" ||
      entry.name === "dist-electron"
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      paths.push(...walk(absolutePath));
      continue;
    }

    paths.push(relativePath);
  }

  return paths;
}

function shouldCheckFile(relativePath: string): boolean {
  if (ALLOWED_PATHS.has(relativePath)) return false;

  return (
    relativePath.endsWith(".ts") ||
    relativePath.endsWith(".tsx") ||
    relativePath.endsWith(".js") ||
    relativePath.endsWith(".mjs") ||
    relativePath.endsWith(".json") ||
    relativePath.endsWith(".md")
  );
}

describe("telemetry regression", () => {
  it("removes OCI telemetry source references from tracked source files", () => {
    const files = walk(repoRoot).filter(shouldCheckFile);
    const offenders = new Map<string, string[]>();

    for (const relativePath of files) {
      const content = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
      const matches = FORBIDDEN_SOURCE_PATTERNS.filter((pattern) => content.includes(pattern));
      if (matches.length > 0) {
        offenders.set(relativePath, matches);
      }
    }

    expect(Object.fromEntries(offenders)).toEqual({});
  });
});
