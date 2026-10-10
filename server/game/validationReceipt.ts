import { SignJWT, jwtVerify } from "jose";
import type { GameArtifact } from "../../shared/game/types";
import type { ValidationReport } from "../../shared/game/validation";
import { artifactDigest } from "../../shared/game/artifact";
import { ENV } from "../_core/env";

/** The receipt attests only to the server browser checks, never to gameplay
 * quality. Creator confirmation is recorded separately when publishing. */
export async function issueValidationReceipt(artifact: GameArtifact, report: ValidationReport): Promise<string | null> {
  if (!ENV.cookieSecret || report.status !== "passed") return null;
  const artifactHash = await artifactDigest(artifact);
  if (report.artifactHash !== artifactHash) return null;
  return new SignJWT({ artifactHash, purpose: "artifact-validation" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setAudience(ENV.appId || "arcane")
    .setIssuedAt().setExpirationTime("30m")
    .sign(new TextEncoder().encode(ENV.cookieSecret));
}
export async function verifyValidationReceipt(artifact: GameArtifact, receipt: string): Promise<boolean> {
  if (!ENV.cookieSecret || !receipt) return false;
  try {
    const { payload } = await jwtVerify(receipt, new TextEncoder().encode(ENV.cookieSecret), { algorithms: ["HS256"], audience: ENV.appId || "arcane" });
    return payload.purpose === "artifact-validation" && payload.artifactHash === await artifactDigest(artifact);
  } catch { return false; }
}
