import { Markup } from "telegraf";
import type { Approval } from "@prisma/client";
import type { ApprovalAction, ApprovalPayload } from "../modules/approvals/approval.service.js";

const ACTION_LABELS: Record<ApprovalAction, string> = {
  APPROVE: "✅ Approve",
  EDIT: "✏️ Edit",
  REGENERATE: "🔄 Regenerate",
  SCHEDULE: "🗓️ Schedule",
  REJECT: "❌ Reject",
  SEND: "📤 Send",
  DONT_SEND: "🚫 Don't send",
  CONFIRM: "⚠️ Confirm",
  CANCEL: "Cancel",
};

const LEVEL_LABELS: Record<string, string> = {
  LEVEL_1: "",
  LEVEL_2: "APPROVAL REQUIRED",
  LEVEL_3: "⚠️ EXPLICIT CONFIRMATION REQUIRED",
};

export function renderApprovalMessage(approval: Approval): { text: string; keyboard: ReturnType<typeof Markup.inlineKeyboard> } {
  const payload = approval.payload as unknown as ApprovalPayload;
  const levelLabel = LEVEL_LABELS[approval.level] ?? "";

  const lines: string[] = [];
  if (levelLabel) lines.push(levelLabel);
  lines.push(payload.title.toUpperCase());
  lines.push("");
  lines.push(payload.summary);

  if (payload.fields) {
    lines.push("");
    for (const [key, value] of Object.entries(payload.fields)) {
      lines.push(`${key}:\n${value}`);
    }
  }

  const text = lines.join("\n");

  const buttons = payload.actions.map((action) =>
    Markup.button.callback(ACTION_LABELS[action], `approval:${approval.id}:${action}`),
  );
  // Two buttons per row keeps this readable on a phone screen.
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

export function renderResolvedMessage(approval: Approval): string {
  const payload = approval.payload as unknown as ApprovalPayload;
  const statusLine =
    approval.status === "APPROVED"
      ? "✅ APPROVED"
      : approval.status === "REJECTED"
        ? "❌ REJECTED"
        : approval.status === "CANCELLED"
          ? "🚫 CANCELLED"
          : approval.status;
  return `${statusLine}\n${payload.title.toUpperCase()}\n\n${payload.summary}`;
}
