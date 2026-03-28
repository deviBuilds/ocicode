import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { readBootstrapEnvelope, resolveFdPath } from "./bootstrap";

const BootstrapEnvelopeSchema = Schema.Struct({
  authToken: Schema.String,
  port: Schema.Number,
});

describe("resolveFdPath", () => {
  it("uses procfs on linux", () => {
    expect(resolveFdPath(3, "linux")).toBe("/proc/self/fd/3");
  });

  it("uses devfs on darwin", () => {
    expect(resolveFdPath(3, "darwin")).toBe("/dev/fd/3");
  });

  it("returns undefined on win32", () => {
    expect(resolveFdPath(3, "win32")).toBeUndefined();
  });
});

describe("readBootstrapEnvelope", () => {
  it("reads a bootstrap envelope from a ready fd", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocicode-bootstrap-"));
    const filePath = path.join(tempDir, "bootstrap.jsonl");
    const payload = { authToken: "secret-token", port: 3773 };
    fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    const fd = fs.openSync(filePath, "r");

    try {
      const result = await Effect.runPromise(readBootstrapEnvelope(BootstrapEnvelopeSchema, fd));

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value).toEqual(payload);
      }
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("treats an unavailable fd as missing bootstrap input", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocicode-bootstrap-"));
    const filePath = path.join(tempDir, "bootstrap.jsonl");
    fs.writeFileSync(filePath, "", "utf8");
    const fd = fs.openSync(filePath, "r");
    fs.closeSync(fd);

    try {
      const result = await Effect.runPromise(readBootstrapEnvelope(BootstrapEnvelopeSchema, fd));

      expect(Option.isNone(result)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
