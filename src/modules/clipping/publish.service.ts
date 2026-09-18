import { prisma } from "../../db/prisma.js";
import { draftCaptions, renderCaption, type CaptionOption } from "../content/caption.service.js";

/**
 * Turning a selected clip into something ready to go out.
 *
 * Deliberately stops short of publishing. A selected clip becomes a caption and
 * an approval card like any other post — the same single path to Instagram that
 * everything else uses, rather than a second one that happens to start here.
 */

export class ClipNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClipNotReadyError";
  }
}

export async function clipByRank(rank: number, videoId?: string) {
  const video = videoId
    ? await prisma.sourceVideo.findUnique({ where: { id: videoId } })
    : await prisma.sourceVideo.findFirst({ where: { clips: { some: {} } }, orderBy: { completedAt: "desc" } });
  if (!video) return null;
  return prisma.clip.findFirst({ where: { sourceVideoId: video.id, rank } });
}

/**
 * Writes caption options for one clip.
 *
 * The clip's own transcript is the brief — it is what is actually said, which is
 * better material than anything he would have to retype. The craft rules and
 * the facts about him come along with it, because this goes through the same
 * writer as every other caption.
 */
export async function captionsForClip(rank: number, videoId?: string): Promise<{
  title: string;
  options: CaptionOption[];
  rendered: string[];
}> {
  const clip = await clipByRank(rank, videoId);
  if (!clip) throw new ClipNotReadyError(`I can't find clip ${rank}.`);
  if (!clip.transcript.trim()) {
    throw new ClipNotReadyError(`Clip ${rank} has no transcript, so there's nothing to write from.`);
  }

  const options = await draftCaptions({
    brief: `A ${Math.round(clip.endSeconds - clip.startSeconds)}-second clip from a longer video, titled "${clip.title}". ${clip.reason}`,
    whatItShows: `What he says in it: "${clip.transcript}"`,
  });

  return { title: clip.title, options, rendered: options.map(renderCaption) };
}

/**
 * The clips he has chosen that are cut and could go out today.
 *
 * A selected clip with no asset was ranked below the few rendered up front; it
 * needs cutting before it can be posted, and saying so is more use than leaving
 * it out of the list.
 */
export async function readyToPublish(videoId?: string) {
  const video = videoId
    ? { id: videoId }
    : await prisma.sourceVideo.findFirst({ where: { clips: { some: {} } }, orderBy: { completedAt: "desc" } });
  if (!video) return { ready: [], needCutting: [] };

  const selected = await prisma.clip.findMany({
    where: { sourceVideoId: video.id, decision: "SELECTED" },
    orderBy: { rank: "asc" },
  });

  return {
    ready: selected.filter((clip) => clip.assetId),
    needCutting: selected.filter((clip) => !clip.assetId),
  };
}
