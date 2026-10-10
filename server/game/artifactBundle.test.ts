import { describe, expect, it } from "vitest";
import { artifactDigest, normalizeGameFiles, validateArtifact } from "../../shared/game/artifact";
import { bundleGameArtifact } from "../../shared/game/bundle";
import type { GameArtifact } from "../../shared/game/types";

const artifact: GameArtifact = { title: "离线", description: "测试", controls: [], files: [{ path: "index.html", language: "html", content: '<head><link rel="stylesheet" href="styles/main.css"><script defer src="js/main.js"></script></head><body><button>0</button></body>' }, { path: "styles/main.css", language: "css", content: "button{color:green}" }, { path: "js/main.js", language: "javascript", content: "document.querySelector('button').onclick=function(){this.textContent='1'}" }] };
describe("snapshot validation and offline compilation", () => {
  it("rejects unsafe original records rather than silently pruning them", () => {
    const unsafe = { ...artifact, files: [...artifact.files, { path: "../secret", content: "bad" }] };
    expect(validateArtifact(unsafe).artifact).toBeNull();
    for (const path of ["index.html/../bad", "a//b.js", "a/./b", "CON.txt", "/index.html", "a\\b", "file."]) expect(() => normalizeGameFiles([{ path, content: "x" }])).toThrow();
    expect(() => normalizeGameFiles([{ path: "index.html", content: "x" }, { path: "INDEX.HTML", content: "y" }])).toThrow();
  });
  it("hashes every source byte and metadata independently of file order", async () => {
    expect(await artifactDigest(artifact)).toBe(await artifactDigest({ ...artifact, files: [...artifact.files].reverse() }));
    expect(await artifactDigest(artifact)).not.toBe(await artifactDigest({ ...artifact, description: "edited" }));
    expect(await artifactDigest(artifact)).not.toBe(await artifactDigest({ ...artifact, files: artifact.files.map((file, i) => i ? file : { ...file, content: file.content + " " }) }));
  });
  it("preserves defer order, compiles reachable references and enforces network policy", () => {
    const bundle = bundleGameArtifact(artifact);
    expect(bundle.html).toContain('defer="" src="data:text/javascript;base64,');
    expect(bundle.html).toContain("button{color:green}");
    expect(bundle.html).toContain("connect-src 'none'");
    expect(bundle.referencedFiles).toEqual(["index.html", "js/main.js", "styles/main.css"]);
  });
  it("blocks broken syntax, missing imports, outside URLs and cyclic modules", () => {
    for (const src of ["missing.js", "https://outside.example/lib.js"]) expect(() => bundleGameArtifact({ ...artifact, files: [{ path: "index.html", language: "html", content: `<script src="${src}"></script>` }] })).toThrow();
    expect(() => bundleGameArtifact({ ...artifact, files: [{ path: "index.html", language: "html", content: "<script>let x=;</script>" }] })).toThrow(/语法/);
    expect(() => bundleGameArtifact({ ...artifact, files: [{ path: "index.html", language: "html", content: '<script type="module" src="a.js"></script>' }, { path: "a.js", language: "javascript", content: "import './b.js'" }, { path: "b.js", language: "javascript", content: "import './a.js'" }] })).toThrow(/循环/);
  });
});
