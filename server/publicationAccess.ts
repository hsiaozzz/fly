import { createHash, timingSafeEqual } from "node:crypto";

type PublicationAccess = { ownerId: number; visibility: "private" | "unlisted" | "public"; shareTokenHash: string | null; revokedAt: Date | null };
export function canReadPublication(publication: PublicationAccess, userId?: number, shareToken?: string): boolean {
  if (publication.revokedAt) return false;
  if (publication.ownerId === userId || publication.visibility === "public") return true;
  if (publication.visibility !== "unlisted" || !shareToken || !publication.shareTokenHash || !/^[a-f0-9]{64}$/.test(publication.shareTokenHash)) return false;
  const presented = createHash("sha256").update(shareToken, "utf8").digest();
  return timingSafeEqual(presented, Buffer.from(publication.shareTokenHash, "hex"));
}
