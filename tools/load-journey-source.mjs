import { build } from "esbuild";
import { resolve } from "node:path";
import vm from "node:vm";

/** Build current TS source in memory; demos are exported snapshots, not tests. */
export async function loadJourneySource() {
  const bundle = await build({
    stdin: { contents: `import { DEFAULT_JOURNEY_DATA } from './shared/game/journeyData'; import { JOURNEY_ENGINE_JS, journeyShell } from './shared/game/journeyEngine'; globalThis.__JOURNEY_SOURCE__ = { data: DEFAULT_JOURNEY_DATA, engine: JOURNEY_ENGINE_JS, journeyShell };`, resolveDir: resolve(process.cwd()), loader: "ts" },
    bundle: true, write: false, format: "iife", platform: "node", logLevel: "silent",
  });
  const scope = {};
  vm.runInNewContext(bundle.outputFiles[0].text, scope);
  return scope.__JOURNEY_SOURCE__;
}
