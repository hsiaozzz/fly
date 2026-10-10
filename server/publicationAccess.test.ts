import { describe, expect, it } from "vitest";
import { sha256 } from "./versionPersistence";
import { canReadPublication } from "./publicationAccess";
const privatePublication = { ownerId: 1, visibility: "private" as const, shareTokenHash: null, revokedAt: null };
describe("publication visibility and revocable sharing", () => {
  it("keeps private snapshots available only to their owner", () => {
    expect(canReadPublication(privatePublication, 1)).toBe(true);
    expect(canReadPublication(privatePublication, 2)).toBe(false);
    expect(canReadPublication(privatePublication)).toBe(false);
  });
  it("requires the complete token for an unlisted snapshot", () => {
    const publication = { ...privatePublication, visibility: "unlisted" as const, shareTokenHash: sha256("secret-share-token") };
    expect(canReadPublication(publication, undefined, "secret-share-token")).toBe(true);
    expect(canReadPublication(publication, undefined, "wrong")).toBe(false);
    expect(canReadPublication(publication)).toBe(false);
  });
  it("revokes access for owners, public visitors and previous valid share links", () => {
    const publication = { ...privatePublication, visibility: "public" as const };
    expect(canReadPublication(publication)).toBe(true);
    expect(canReadPublication({ ...publication, revokedAt: new Date() }, 1)).toBe(false);
    expect(canReadPublication({ ...publication, revokedAt: new Date() })).toBe(false);
  });
});
