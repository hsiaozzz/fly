import type { GameArtifact } from "../../../shared/game/types";
import { injectRuntimeProbe } from "../../../shared/game/runtimeProbe";
import { bundleGameArtifact } from "../../../shared/game/bundle";

/**
 * The preview iframe runs the actual generated game: the LLM-authored
 * `index.html` (self-contained HTML5) is rendered via srcDoc.
 *
 * A tiny baseline reset is injected so generated games fill the preview
 * window instead of leaving large empty margins (some LLM-authored pages
 * forget `html,body{height:100%}`). Defaults precede authored styles so the
 * game controls its own layout, and long game pages remain scrollable.
 */
const SANDBOX_RESET = `<style>html,body{height:100%;margin:0;overflow:auto;background:#0b1220}</style>`;

export function createGameSandbox(
  artifact: GameArtifact | null,
  runId = ""
): string {
  if (!artifact) return "";
  let content: string;
  try {
    content = bundleGameArtifact(artifact).html;
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : "游戏打包失败"
    ).replace(
      /[&<>"']/g,
      char =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!
    );
    return `<!doctype html><html><body style="background:#07111f;color:#fca5a5;font-family:ui-sans-serif,sans-serif;padding:24px"><h3>预览构建失败</h3><pre style="white-space:pre-wrap">${message}</pre></body></html>`;
  }
  if (/<head\b[^>]*>/i.test(content)) {
    content = content.replace(
      /<head\b[^>]*>/i,
      match => `${match}${SANDBOX_RESET}`
    );
  } else {
    content = `${SANDBOX_RESET}${content}`;
  }

  // This observational probe never sends synthetic game inputs. The parent
  // validates the iframe source and runId; trusted QA runs in a server worker.
  return injectRuntimeProbe(content, runId);
}
