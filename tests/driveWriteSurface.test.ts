import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The bot's access to Drive is read-only, and these keep it that way.
 *
 * Reading the source rather than calling the functions is deliberate: a test
 * that called them would only cover the ones it thought to call, while this
 * fails when someone adds a new one.
 */
const source = readFileSync(new URL("../src/modules/drive/drive.service.ts", import.meta.url), "utf8");
const scopes = readFileSync(new URL("../src/modules/oauth/scopes.ts", import.meta.url), "utf8");

describe("the bot's access to Drive", () => {
  it("makes no modifying request of any kind", () => {
    expect(source).not.toMatch(/method:\s*["'](POST|PATCH|PUT|DELETE)["']/i);
  });

  it("never deletes or trashes a file", () => {
    expect(source).not.toMatch(/trashed:\s*true/);
    expect(source).not.toMatch(/files\.delete|\/trash\b/);
  });

  it("does not upload or overwrite file contents", () => {
    expect(source).not.toContain("uploadType");
    expect(source).not.toContain("upload/drive");
  });

  it("asks Google only for read access, so a mistake cannot cost him footage", () => {
    expect(scopes).toContain("auth/drive.readonly");
    // The broad scope would permit deleting his Drive; nothing here needs it.
    expect(scopes).not.toMatch(/auth\/drive["'\s]/);
  });
});
