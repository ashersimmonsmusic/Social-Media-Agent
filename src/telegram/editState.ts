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
