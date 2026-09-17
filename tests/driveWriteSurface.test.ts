import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The Drive scope had to widen from read-only so files can be renamed — Google
 * offers nothing in between. What stops that mattering is that the code makes
 * exactly one kind of write, so these assert the surface rather than the grant.
 *
 * Reading the source is deliberate. A test that called the functions would only
 * cover the ones it thought to call; this fails when someone adds a new one.
 */
const source = readFileSync(new URL("../src/modules/drive/drive.service.ts", import.meta.url), "utf8");

describe("the bot's write surface on Drive", () => {
  it("never deletes or trashes a file", () => {
    expect(source).not.toMatch(/method:\s*["']DELETE["']/i);
    expect(source).not.toMatch(/trashed:\s*true/);
    expect(source).not.toMatch(/files\.delete|\/trash\b/);
  });

  it("makes exactly one modifying request", () => {
    const writes = source.match(/method:\s*["'](POST|PATCH|PUT|DELETE)["']/gi) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/PATCH/i);
  });

  it("sends only a name on that request, so nothing else can be changed", () => {
    // A body carrying parents would move the file; one carrying anything else
    // would change it. The rename must be the whole payload.
    const body = source.match(/body:\s*JSON\.stringify\(\{([^}]*)\}\)/);
    expect(body).not.toBeNull();
    expect(body![1]!.trim()).toBe("name: finalName");
  });

  it("does not upload or overwrite file contents", () => {
    expect(source).not.toContain("uploadType");
    expect(source).not.toContain("upload/drive");
  });
});
