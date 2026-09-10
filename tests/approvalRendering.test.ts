import { describe, expect, it } from "vitest";
import type { Approval } from "@prisma/client";
import { renderApprovalMessage, renderResolvedMessage } from "../src/telegram/approvals.render.js";
import type { ApprovalPayload } from "../src/modules/approvals/approval.service.js";

function fakeApproval(overrides: Partial<Approval> & { payload: ApprovalPayload }): Approval {
  return {
    id: "approval_123",
    type: "GENERIC",
    level: "LEVEL_2",
    status: "PENDING",
    telegramChatId: null,
    telegramMessageId: null,
    requestedAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    payload: overrides.payload as never,
  };
}

describe("renderApprovalMessage", () => {
  it("includes the level 2 approval-required banner and every requested action button", () => {
    const approval = fakeApproval({
      level: "LEVEL_2",
      payload: {
        title: "New content ready",
        summary: "Instagram Reel for Brighter Days",
        fields: { Caption: "Some caption text" },
        actions: ["APPROVE", "EDIT", "REGENERATE", "REJECT"],
      },
    });

    const { text, keyboard } = renderApprovalMessage(approval);

    expect(text).toContain("APPROVAL REQUIRED");
    expect(text).toContain("NEW CONTENT READY");
    expect(text).toContain("Some caption text");

    const callbackData = keyboard.reply_markup.inline_keyboard.flat().map((btn) => btn.callback_data);
    expect(callbackData).toEqual([
      "approval:approval_123:APPROVE",
      "approval:approval_123:EDIT",
      "approval:approval_123:REGENERATE",
      "approval:approval_123:REJECT",
    ]);
  });

  it("marks level 3 approvals with an explicit-confirmation banner", () => {
    const approval = fakeApproval({
      level: "LEVEL_3",
      payload: { title: "Send £50 ad spend", summary: "Boost the release post", actions: ["CONFIRM", "CANCEL"] },
    });

    const { text } = renderApprovalMessage(approval);
    expect(text).toContain("EXPLICIT CONFIRMATION REQUIRED");
  });
});

describe("renderResolvedMessage", () => {
  it("shows an approved banner once resolved", () => {
    const approval = fakeApproval({
      status: "APPROVED",
      payload: { title: "New caption draft ready", summary: "Idea: new single", actions: ["APPROVE"] },
    });
    expect(renderResolvedMessage(approval)).toContain("✅ APPROVED");
  });

  it("shows a rejected banner once resolved", () => {
    const approval = fakeApproval({
      status: "REJECTED",
      payload: { title: "Outreach ready", summary: "Radio pitch", actions: ["SEND"] },
    });
    expect(renderResolvedMessage(approval)).toContain("❌ REJECTED");
  });
});
