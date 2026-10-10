import { parse, tokenizer } from "acorn";
import type { GameFile } from "./types";

export type SourceToken = { kind: string; value: string };
export type ScriptSource = { path: string; content: string; module: boolean };

/** Tokens distinguish executable identifiers from prose, comments and literals. */
export function sourceTokens(source: string): SourceToken[] {
  const out: SourceToken[] = [];
  try {
    const stream = tokenizer(source, { ecmaVersion: "latest", sourceType: "module" });
    for (;;) {
      const token = stream.getToken();
      if (token.type.label === "eof") break;
      out.push({ kind: token.type.label, value: String((token as { value?: unknown }).value ?? token.type.label) });
    }
  } catch { /* Syntax diagnostics are reported separately; never manufacture tokens. */ }
  return out;
}

export function referencePath(owner: string, reference: string): string | null {
  if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(reference)) return null;
  const raw = reference.split(/[?#]/)[0];
  const stack = raw.startsWith("/") ? [] : owner.split("/").slice(0, -1);
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!stack.length) return null; stack.pop(); }
    else stack.push(part);
  }
  return stack.join("/");
}

export function htmlSource(files: GameFile[]): string {
  return (files.find(file => file.path === "index.html")?.content ?? "").replace(/<!--[\s\S]*?-->/g, "");
}

function attr(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes)?.slice(1).find(value => value !== undefined);
}

/** Only scripts reachable from index.html can satisfy a runtime presence gate. */
export function activeScripts(files: GameFile[]): { scripts: ScriptSource[]; missing: string[] } {
  const scripts: ScriptSource[] = [], missing: string[] = [], visited = new Set<string>();
  const byPath = new Map(files.map(file => [file.path, file]));
  function visit(path: string, content?: string, module = false) {
    if (visited.has(path)) return;
    visited.add(path);
    const text = content ?? byPath.get(path)?.content;
    if (text === undefined) { missing.push(path); return; }
    scripts.push({ path, content: text, module: module || path.endsWith(".mjs") });
    const tokens = sourceTokens(text);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.value !== "from" && token.value !== "import") continue;
      const next = tokens[i + 1]?.value === "(" ? tokens[i + 2] : tokens[i + 1];
      if (next?.kind !== "string") continue;
      const dependency = referencePath(path.split("#")[0], next.value);
      if (dependency && /\.(?:m?js|ts)$/i.test(dependency)) visit(dependency, undefined, true);
    }
  }
  let inline = 0;
  for (const match of htmlSource(files).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = attr(match[1], "type")?.toLowerCase();
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    const src = attr(match[1], "src");
    if (src) { const path = referencePath("index.html", src); if (path) visit(path, undefined, type === "module"); }
    else visit(`index.html#script-${++inline}`, match[2], type === "module");
  }
  return { scripts, missing };
}

export function executableTokens(files: GameFile[]): SourceToken[] {
  return activeScripts(files).scripts.flatMap(script => sourceTokens(script.content));
}

export function codeOnly(files: GameFile[]): string {
  return executableTokens(files).map(token => token.kind === "string" || token.kind === "regexp" || token.kind === "template" ? "__literal__" : token.value).join(" ");
}

export function calls(tokens: SourceToken[], name: string, literal?: RegExp): boolean {
  return tokens.some((token, i) => token.kind !== "string" && token.value === name && tokens[i + 1]?.value === "(" && (!literal || tokens[i + 2]?.kind === "string" && literal.test(tokens[i + 2].value)));
}

/** Follow event callbacks into named functions, rather than counting unrelated draws. */
export function hasEventDrivenRender(files: GameFile[]): boolean {
  const canvas = /<canvas[\s>]/i.test(htmlSource(files).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")) || calls(executableTokens(files), "getContext", /^2d$/);
  const functions = new Map<string, any>(), handlers: any[] = [];
  const inputEvent = /^(?:key(?:down|up|press)|pointer(?:down|up|move)|mouse(?:down|up|move)|click|touch(?:start|move|end))$/i;
  const property = (node: any): string | undefined => node?.computed ? typeof node.property?.value === "string" ? node.property.value : undefined : node?.property?.name;
  function children(node: any, visit: (node: any) => void) {
    for (const [key, value] of Object.entries(node ?? {})) {
      if (["start", "end", "loc"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  function collect(node: any) {
    if (!node?.type) return;
    if (node.type === "FunctionDeclaration" && node.id) functions.set(node.id.name, node);
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && /FunctionExpression$/.test(node.init?.type ?? "")) functions.set(node.id.name, node.init);
    if (node.type === "CallExpression" && (property(node.callee) === "addEventListener" || node.callee?.type === "Identifier" && node.callee.name === "addEventListener") && inputEvent.test(node.arguments?.[0]?.value ?? "")) handlers.push(node.arguments[1]);
    if (node.type === "AssignmentExpression" && /^on(?:key|pointer|mouse|click|touch)/.test(property(node.left) ?? "")) handlers.push(node.right);
    children(node, collect);
  }
  for (const script of activeScripts(files).scripts) {
    try { collect(parse(script.content, { ecmaVersion: "latest", sourceType: script.module ? "module" : "script" })); } catch { /* Separate syntax gate provides diagnostics. */ }
  }
  const html = htmlSource(files).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  for (const match of html.matchAll(/\bon(?:click|keydown|pointerdown)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    try { handlers.push(parse(`function handler(){${match[1] ?? match[2]}}`, { ecmaVersion: "latest" }).body[0]); } catch { /* Browser bundle reports malformed handlers. */ }
  }
  function renders(node: any, visited: Set<string>, descendFunction = false): boolean {
    if (!node?.type) return false;
    if (node.type === "Identifier") return false;
    if (/Function/.test(node.type)) return descendFunction ? renders(node.body, visited) : false;
    if (node.type === "CallExpression") {
      const method = property(node.callee);
      if (canvas && /^(?:fillRect|clearRect|fillText|strokeText|drawImage|putImageData)$/.test(method ?? "")) return true;
      if (!canvas && /^(?:appendChild|replaceChildren|setAttribute)$/.test(method ?? "")) return true;
      if (!canvas && property(node.callee?.object) === "classList" && /^(?:add|remove|toggle|replace)$/.test(method ?? "")) return true;
      if (node.callee?.type === "Identifier" && !visited.has(node.callee.name) && functions.has(node.callee.name) && renders(functions.get(node.callee.name), new Set([...visited, node.callee.name]), true)) return true;
    }
    if (!canvas && node.type === "AssignmentExpression" && /^(?:textContent|innerText|innerHTML)$/.test(property(node.left) ?? "")) return true;
    if (!canvas && node.type === "AssignmentExpression" && property(node.left?.object) === "style") return true;
    let found = false; children(node, child => { if (!found && renders(child, visited)) found = true; }); return found;
  }
  return handlers.some(handler => handler?.type === "Identifier" ? functions.has(handler.name) && renders(functions.get(handler.name), new Set([handler.name]), true) : renders(handler, new Set(), /Function/.test(handler?.type ?? "")));
}
