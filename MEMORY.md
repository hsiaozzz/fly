# Development Memory

## 2026-08-12 — Workbench verification

The initial desktop view renders as a dark, compact game-building workbench with chat, preview controls, a sandboxed preview surface, and an IDE-style bottom dock. The example generation action was triggered through the user interface. The client accepted the Chinese Flappy Bird prompt, changed its state to `Planner · Understanding the game request…`, displayed the user message, created the streaming assistant placeholder, and enabled the Stop control. The next verification step is to confirm the stream completes into a validated multi-file project and that the preview iframe, file tree, console, GameSpec, patch flow, and ZIP export remain functional.

The stream completed into `Bluebird Passage`, a 16-file Phaser + TypeScript + Vite project. The preview canvas, project tree, README editor and completion indicators rendered correctly. A duplicate completion reply was discovered and corrected by updating the existing streaming message instead of appending a second assistant message. An attempt to enter a patch request occurred during hot reload and used a stale DOM index; obtain a fresh browser snapshot before retrying the Patch Agent test.

After the hot reload, the browser correctly reset its transient local workspace state. A second example generation was started to confirm the stream reply de-duplication fix. The request moved into the Planner state and exposed the Stop control as expected; wait for completion before performing the revised Patch Agent validation.

The second generation completed successfully with one assistant completion message, confirming the stream de-duplication fix. The workbench exposed its precise change composer. The request “把小鸟速度提高 30%，并把管道之间的距离变大。” was entered successfully; the next action is to invoke `Apply patch` and confirm that the configuration file changes while the project remains a 16-file structure.

The Patch Agent successfully applied two operations and retained a 16-file project. The workbench selected `src/config/game.config.ts`, which showed `playerSpeed: 416` and `obstacleGap: 240`; this verifies a precise update rather than a full regeneration. The `Download ZIP` action then completed and showed a success toast for the complete game-project archive.

The browser validation session is unauthenticated, so it cannot exercise persistent project/version storage without an OAuth login. The final UI nevertheless exposes an explicit Restart Game control, in addition to desktop/mobile/fullscreen/reload controls. A fresh example project generation was triggered in order to verify this control with a populated sandbox after the stream completes.

The fresh 16-file example completed and the explicit `Restart Game` control was clicked. The visible status changed to `Game restarted in a fresh sandbox runtime` and the iframe returned to the game’s initial ready screen, confirming an immediate restart without requiring a Game Over condition.
