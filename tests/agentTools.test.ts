import { describe, expect, it } from "vitest";
import { AGENT_TOOLS } from "../src/ai/agentTools.js";

/**
 * The agent talks freely, so the guarantee that it cannot act on the outside
 * world has to come from the tool surface itself rather than from the system
 * prompt. These assertions fail loudly if a future change hands it one.
 */
describe("agent tool surface", () => {
  const names = AGENT_TOOLS.map((t) => t.name);

  it("exposes no tool that publishes, sends, spends, or deletes", () => {
    const forbidden = /publish|post_to|send|email|dm|message_contact|pay|spend|purchase|delete|remove/i;
    const offenders = names.filter((name) => forbidden.test(name));
    expect(offenders).toEqual([]);
  });

  it("routes anything outward-facing through an approval", () => {
    expect(names).toContain("propose_for_approval");
    const proposeTool = AGENT_TOOLS.find((t) => t.name === "propose_for_approval")!;
    expect(proposeTool.description.toLowerCase()).toContain("approv");
  });

  it("gives every tool a description and a valid object schema", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema).toHaveProperty("properties");
    }
  });

  it("can look up facts before asserting them", () => {
    expect(names).toContain("search_knowledge");
    expect(names).toContain("get_brand_bible");
  });
});
