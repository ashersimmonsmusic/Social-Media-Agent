import { describe, expect, it, vi } from "vitest";

const recordAuditMock = vi.fn(async () => undefined);

vi.mock("../src/modules/audit/audit.service.js", () => ({
  recordAudit: recordAuditMock,
}));

const approvalStore = new Map<string, Record<string, unknown>>();

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    approval: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const id = `approval_${approvalStore.size + 1}`;
        const record = { id, requestedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...args.data };
        approvalStore.set(id, record);
        return record;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = approvalStore.get(args.where.id);
        if (!existing) throw new Error("not found");
        const updated = { ...existing, ...args.data };
        approvalStore.set(args.where.id, updated);
        return updated;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => approvalStore.get(args.where.id) ?? null),
    },
  },
}));

const { createApproval, resolveApproval, getApproval } = await import("../src/modules/approvals/approval.service.js");

describe("approval lifecycle", () => {
  it("creates a PENDING approval and logs it", async () => {
    const approval = await createApproval({
      level: "LEVEL_2",
      payload: { title: "New caption draft ready", summary: "Idea: test", actions: ["APPROVE", "REJECT"] },
    });

    expect(approval.status).toBe("PENDING");
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "approval.requested" }));
  });

  it("only resolves via an explicit status passed by the caller, never inferred", async () => {
    const approval = await createApproval({
      level: "LEVEL_3",
      payload: { title: "Confirm ad spend", summary: "£50 boost", actions: ["CONFIRM", "CANCEL"] },
    });

    const resolved = await resolveApproval(approval.id, "APPROVED", "asher-chat-id");

    expect(resolved.status).toBe("APPROVED");
    expect(resolved.resolvedBy).toBe("asher-chat-id");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "approval.approved", actorType: "ASHER" }));

    const fetched = await getApproval(approval.id);
    expect(fetched?.status).toBe("APPROVED");
  });
});
