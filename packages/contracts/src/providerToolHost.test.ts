import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderToolApplyPatchArgs } from "./providerToolHost";

const decodeProviderToolApplyPatchArgs = Schema.decodeUnknownSync(ProviderToolApplyPatchArgs);

describe("ProviderToolApplyPatchArgs", () => {
  it("preserves trailing newlines in patch payloads", () => {
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
    const parsed = decodeProviderToolApplyPatchArgs({ patch });
    expect(parsed.patch).toBe(patch);
  });
});
