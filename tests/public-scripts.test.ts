import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("browser scripts", () => {
  for (const page of ["send.html", "recv.html"]) {
    test(`${page} contains valid JavaScript`, async () => {
      const html = await Bun.file(join(import.meta.dir, "..", "public", page)).text();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];

      expect(scripts).toHaveLength(1);
      expect(() => new Function(scripts[0]?.[1] ?? "")).not.toThrow();
    });
  }
});
