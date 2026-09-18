import { beforeEach, describe, expect, it } from "vitest";

const { setAwaitingRename, takeAwaitingRename, clearAwaitingRename, setAwaitingEdit, takeAwaitingEdit } = await import(
  "../src/telegram/editState.js"
);

const chat = "12345";

beforeEach(() => {
  clearAwaitingRename(chat);
  takeAwaitingEdit(chat);
});

describe("awaiting a rename", () => {
  it("remembers which file his next message names", () => {
    setAwaitingRename(chat, "file-1", "00066.MTS");
    expect(takeAwaitingRename(chat)).toEqual({ fileId: "file-1", currentName: "00066.MTS" });
  });

  it("is consumed once, so the message after it is ordinary conversation again", () => {
    setAwaitingRename(chat, "file-1", "x.mp4");
    takeAwaitingRename(chat);
    expect(takeAwaitingRename(chat)).toBeUndefined();
  });

  it("returns nothing when no rename is pending", () => {
    expect(takeAwaitingRename(chat)).toBeUndefined();
  });

  it("can be cancelled without being consumed as an answer", () => {
    setAwaitingRename(chat, "file-1", "x.mp4");
    clearAwaitingRename(chat);
    expect(takeAwaitingRename(chat)).toBeUndefined();
  });

  it("keeps chats separate", () => {
    setAwaitingRename(chat, "file-1", "a.mp4");
    setAwaitingRename("99999", "file-2", "b.mp4");

    expect(takeAwaitingRename(chat)!.fileId).toBe("file-1");
    expect(takeAwaitingRename("99999")!.fileId).toBe("file-2");
  });

  it("does not collide with a pending approval edit", () => {
    // Both wait for the next message; taking one must not consume the other.
    setAwaitingRename(chat, "file-1", "a.mp4");
    setAwaitingEdit(chat, "approval-1");

    expect(takeAwaitingRename(chat)!.fileId).toBe("file-1");
    expect(takeAwaitingEdit(chat)).toBe("approval-1");
  });

  it("replaces an earlier pending rename rather than queueing it", () => {
    setAwaitingRename(chat, "file-1", "a.mp4");
    setAwaitingRename(chat, "file-2", "b.mp4");
    expect(takeAwaitingRename(chat)!.fileId).toBe("file-2");
  });
});
