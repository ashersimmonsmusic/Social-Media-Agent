// In-memory "what is Asher's next text reply for" state, per chat.
// Deliberately not persisted: if the process restarts mid-edit, the
// Approval stays PENDING and Asher can just press EDIT again. Losing this
// one piece of transient UI state is an acceptable trade-off for not
// needing a table for it in Phase 1.
const awaitingEdit = new Map<string, string>();

export function setAwaitingEdit(chatId: string, approvalId: string) {
  awaitingEdit.set(chatId, approvalId);
}

export function takeAwaitingEdit(chatId: string): string | undefined {
  const approvalId = awaitingEdit.get(chatId);
  if (approvalId) awaitingEdit.delete(chatId);
  return approvalId;
}

/**
 * Which Drive file his next message is naming.
 *
 * Same trade as above: not persisted, because a restart mid-rename costs him
 * one tap to start again, and a table for it would be out of proportion.
 */
const awaitingRename = new Map<string, { fileId: string; currentName: string }>();

export function setAwaitingRename(chatId: string, fileId: string, currentName: string) {
  awaitingRename.set(chatId, { fileId, currentName });
}

export function takeAwaitingRename(chatId: string): { fileId: string; currentName: string } | undefined {
  const pending = awaitingRename.get(chatId);
  if (pending) awaitingRename.delete(chatId);
  return pending;
}

/** Lets a command cancel a rename it started, without consuming it. */
export function clearAwaitingRename(chatId: string) {
  awaitingRename.delete(chatId);
}
