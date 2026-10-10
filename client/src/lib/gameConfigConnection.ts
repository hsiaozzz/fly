import { parse as parseHtml } from "parse5";
import { parse as parseJavaScript } from "acorn";
import { bundleGameArtifact } from "@shared/game/bundle";
import type { GameArtifact } from "@shared/game/types";

/** Recognizes a supported config connection in the game's executable graph. */
export function gameConfigIsConnected(artifact: GameArtifact): boolean {
  try {
    const executablePaths = new Set(
      bundleGameArtifact(artifact).referencedFiles
    );
    const scripts: { content: string; module: boolean }[] = [];
    for (const file of artifact.files) {
      if (!executablePaths.has(file.path)) continue;
      if (/\.[cm]?js$/i.test(file.path))
        scripts.push({ content: file.content, module: true });
      else if (file.path === "index.html") {
        const collectScripts = (node: any): void => {
          if (node.tagName === "script") {
            const type =
              node.attrs?.find((attribute: any) => attribute.name === "type")
                ?.value ?? "";
            if (!type || type === "module" || /(?:java|ecma)script/.test(type))
              scripts.push({
                content: (node.childNodes ?? [])
                  .map((child: any) => child.value ?? "")
                  .join(""),
                module: type === "module",
              });
          }
          for (const child of node.childNodes ?? []) collectScripts(child);
        };
        collectScripts(parseHtml(file.content));
      }
    }
    let loadsConfig = false,
      readsParameters = false;
    const visit = (node: any): void => {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "CallExpression" &&
        node.callee?.type === "Identifier" &&
        node.callee.name === "fetch"
      ) {
        const argument = node.arguments[0];
        if (
          argument?.type === "Literal" &&
          typeof argument.value === "string" &&
          /^(?:\.\/|\/)?arcane\.config\.json$/.test(argument.value)
        )
          loadsConfig = true;
      }
      if (
        node.type === "MemberExpression" &&
        ((node.property?.type === "Identifier" &&
          !node.computed &&
          node.property.name === "parameters") ||
          (node.computed && node.property?.value === "parameters"))
      )
        readsParameters = true;
      if (
        node.type === "ObjectPattern" &&
        node.properties?.some(
          (property: any) =>
            property.key?.name === "parameters" ||
            property.key?.value === "parameters"
        )
      )
        readsParameters = true;
      for (const [key, value] of Object.entries(node)) {
        if (["start", "end", "loc"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    };
    for (const script of scripts)
      visit(
        parseJavaScript(script.content, {
          ecmaVersion: "latest",
          sourceType: script.module ? "module" : "script",
        })
      );
    return loadsConfig && readsParameters;
  } catch {
    return false;
  }
}
