import { z } from "zod";
import { existsSync } from "node:fs";
import { deriveAppCapabilities, systemBrowserCandidates } from "../../shared/appCapabilities";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";

/** No request context, authentication, file reads or external service probes. */
export function runtimeCapabilities() {
  const configuredBrowser = process.env.ARCANE_BROWSER_EXECUTABLE;
  const browserDetected = (configuredBrowser?.trim() ? [configuredBrowser] : systemBrowserCandidates(process.platform)).some(candidate => existsSync(candidate));
  return deriveAppCapabilities(process.env, browserDetected);
}

export const systemRouter = router({
  capabilities: publicProcedure.query(runtimeCapabilities),
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),
});
