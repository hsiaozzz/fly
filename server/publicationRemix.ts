import type { GameArtifact } from "../shared/game/types";

/** A remix is a new snapshot: retain source bytes, but change its identity so a
 * source receipt cannot certify the derived version without another check. */
export function createRemixArtifact(original: GameArtifact): GameArtifact {
  const remix = structuredClone(original);
  remix.title = `${original.title.slice(0, 114).trimEnd()} remix`;
  // A maximum-length source may already end in the truncated suffix. Ensure
  // deriving it still changes the snapshot metadata and invalidates its receipt.
  if (remix.title === original.title) remix.title = `${original.title.slice(0, 114)} Remix`;
  return remix;
}
