import { describe, expect, it } from "vitest";
import { COMMANDS, commandTrigger } from "../src/telegram/commands/trigger.js";

/**
 * Telegraf tests a command trigger against the command name with the leading
 * slash already stripped. These assertions mirror that, and pin the
 * case-insensitivity that stops a phone-autocapitalised "/Caption" from
 * falling through to the generic text handler.
 */
describe("commandTrigger", () => {
  it("matches the exact lowercase command", () => {
    const [trigger] = commandTrigger("caption");
    expect(trigger!.test("caption")).toBe(true);
  });

  it("matches a capitalised command, as phone keyboards produce", () => {
    const [trigger] = commandTrigger("caption");
    expect(trigger!.test("Caption")).toBe(true);
    expect(trigger!.test("CAPTION")).toBe(true);
  });

  it("does not match a different command or a partial name", () => {
    const [trigger] = commandTrigger("caption");
    expect(trigger!.test("captions")).toBe(false);
    expect(trigger!.test("cap")).toBe(false);
    expect(trigger!.test("brand")).toBe(false);
  });

  it("builds one trigger per alias", () => {
    const triggers = commandTrigger("whatsimportant", "important");
    expect(triggers).toHaveLength(2);
    expect(triggers[0]!.test("WhatsImportant")).toBe(true);
    expect(triggers[1]!.test("Important")).toBe(true);
  });
});

describe("COMMANDS", () => {
  it("lists every command with a description, in Telegram's required lowercase form", () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
    for (const entry of COMMANDS) {
      expect(entry.command).toBe(entry.command.toLowerCase());
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
