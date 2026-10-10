import { parse as parseHtml, serialize } from "parse5";
import { parse as parseJavaScript } from "acorn";
import { validateArtifact } from "./artifact";
import type { GameArtifact } from "./types";
import { validateGameConfig } from "./config";

export class GameBundleError extends Error {}
const mime: Record<string, string> = { js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", svg: "image/svg+xml", html: "text/html", txt: "text/plain" };
const MAX_BUNDLE_BYTES = 8_000_000;
function boundedSource(source: string, path: string): string {
  if (source.length > MAX_BUNDLE_BYTES || new TextEncoder().encode(source).length > MAX_BUNDLE_BYTES) throw new GameBundleError(`依赖展开超出构建大小限制：${path}`);
  return source;
}
export function gameDataUrl(content: string, mediaType: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${mediaType};base64,${btoa(binary)}`;
}

/** Resolves within the snapshot; URL paths cannot escape to the creator origin. */
export function resolveGameReference(from: string, reference: string): string {
  const clean = reference.split(/[?#]/)[0];
  if (!clean || /^[a-z]+:|^\/\//i.test(clean)) throw new GameBundleError(`不支持外部依赖：${reference}`);
  const parts = clean.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const part of clean.replace(/^\//, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new GameBundleError(`资源引用越界：${reference}`);
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

/** Deterministic offline HTML, shared by preview, server QA and publication. */
export function bundleGameArtifact(input: GameArtifact): { html: string; referencedFiles: string[] } {
  const validation = validateArtifact(input);
  if (!validation.artifact) throw new GameBundleError(validation.errors.join("\n"));
  const artifact = validation.artifact;
  const configFile = artifact.files.find(file => file.path === "arcane.config.json");
  if (configFile) {
    let config: unknown;
    try { config = JSON.parse(configFile.content); } catch { throw new GameBundleError("arcane.config.json 不是有效 JSON。"); }
    const configCheck = validateGameConfig(config);
    if (!configCheck.valid) throw new GameBundleError(configCheck.errors.join("\n"));
  }
  const files = new Map(artifact.files.map(file => [file.path, file.content]));
  const referenced = new Set<string>(["index.html"]);
  const required = (from: string, ref: string): { path: string; content: string } => {
    const path = resolveGameReference(from, ref);
    const content = files.get(path);
    if (content === undefined) throw new GameBundleError(`资源不存在：${from} → ${ref}`);
    referenced.add(path);
    return { path, content };
  };
  const resource = (from: string, ref: string): string => {
    if (ref.startsWith("data:") || ref.startsWith("#")) return ref;
    const { path, content } = required(from, ref);
    return gameDataUrl(content, mime[path.split(".").pop() ?? ""] ?? "text/plain");
  };
  const css = (content: string, from: string, stack: string[] = []): string => {
    if (stack.includes(from)) throw new GameBundleError(`CSS 循环依赖：${from}`);
    let result = content.replace(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*;/gi, (_match, ref) => {
      const imported = required(from, ref);
      return css(imported.content, imported.path, [...stack, from]);
    });
    result = result.replace(/url\(\s*(?:["']([^"']+)["']|([^\s)]+))\s*\)/gi, (_match, quoted, unquoted) => `url("${resource(from, quoted ?? unquoted)}")`);
    if (/@import\s/i.test(result)) throw new GameBundleError(`不支持此 CSS import 语法：${from}`);
    return boundedSource(result, from);
  };
  const moduleCache = new Map<string, string>();
  const compileScript = (content: string, from: string, module: boolean, stack: string[] = []): string => {
    let ast: any;
    try { ast = parseJavaScript(content, { ecmaVersion: "latest", sourceType: module ? "module" : "script" }); }
    catch (error) { throw new GameBundleError(`${from} JavaScript 语法错误：${error instanceof Error ? error.message : "无法解析"}`); }
    const replacements: { start: number; end: number; value: string }[] = [];
    const moduleUrl = (ref: string) => {
      if (!ref.startsWith(".") && !ref.startsWith("/")) throw new GameBundleError(`不支持 npm 或外部模块：${ref}`);
      const file = required(from, ref);
      if (!/\.(m?js)$/.test(file.path)) throw new GameBundleError(`仅支持 JavaScript 模块：${file.path}`);
      if (stack.includes(file.path) || file.path === from) throw new GameBundleError(`模块循环依赖：${file.path}`);
      if (!moduleCache.has(file.path)) moduleCache.set(file.path, gameDataUrl(compileScript(file.content, file.path, true, [...stack, from]), "text/javascript"));
      return moduleCache.get(file.path)!;
    };
    const visit = (node: any): void => {
      if (!node || typeof node !== "object") return;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type) && node.source) {
        if (typeof node.source.value !== "string") throw new GameBundleError(`不支持动态计算模块路径：${from}`);
        replacements.push({ start: node.source.start, end: node.source.end, value: JSON.stringify(moduleUrl(node.source.value)) });
      }
      // Static new URL assets retain the same bytes in modules and scripts.
      if (node.type === "NewExpression" && node.callee?.name === "URL" && node.arguments?.[0]?.type === "Literal" && node.arguments[1]?.type === "MemberExpression" && node.arguments[1].object?.type === "MetaProperty") {
        replacements.push({ start: node.start, end: node.end, value: `new URL(${JSON.stringify(resource(from, node.arguments[0].value))})` });
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "source" || key === "start" || key === "end") continue;
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    };
    visit(ast);
    let result = content;
    for (const change of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.value + result.slice(change.end);
    return boundedSource(result, from);
  };
  const document: any = parseHtml(files.get("index.html")!);
  const attr = (node: any, name: string): string | undefined => node.attrs?.find((item: any) => item.name === name)?.value;
  const removeAttr = (node: any, name: string) => { node.attrs = (node.attrs ?? []).filter((item: any) => item.name !== name); };
  const setText = (node: any, value: string) => { node.childNodes = [{ nodeName: "#text", value, parentNode: node }]; };
  const walk = (node: any): void => {
    if (node.tagName === "base") throw new GameBundleError("游戏入口不支持 base 标签。");
    if (node.tagName === "meta" && /refresh/i.test(attr(node, "http-equiv") ?? "")) throw new GameBundleError("游戏入口不支持自动跳转。");
    if (node.tagName === "script") {
      const type = attr(node, "type") ?? "";
      const module = type === "module";
      const src = attr(node, "src");
      let content = (node.childNodes ?? []).map((child: any) => child.value ?? "").join("");
      let from = "index.html";
      if (src) { const file = required("index.html", src); content = file.content; from = file.path; removeAttr(node, "integrity"); removeAttr(node, "crossorigin"); }
      if (!type || module || /(?:java|ecma)script/.test(type)) content = compileScript(content, from, module);
      if (src) {
        node.attrs.find((item: any) => item.name === "src").value = gameDataUrl(content, "text/javascript");
        setText(node, "");
      } else setText(node, content.replace(/<\/script/gi, "<\\/script"));
    }
    if (node.tagName === "link" && (attr(node, "rel") ?? "").split(/\s+/).includes("stylesheet")) {
      const file = required("index.html", attr(node, "href") ?? "");
      node.tagName = node.nodeName = "style"; node.attrs = [];
      setText(node, css(file.content, file.path));
    } else if (node.tagName === "style") setText(node, css((node.childNodes ?? []).map((child: any) => child.value ?? "").join(""), "index.html"));
    for (const item of node.attrs ?? []) {
      if (item.name === "style") item.value = css(item.value, "index.html");
      if ((["img", "audio", "video", "source", "track", "input"].includes(node.tagName) && item.name === "src") || item.name === "poster" || (node.tagName === "link" && item.name === "href")) item.value = resource("index.html", item.value);
      if (item.name === "srcset") throw new GameBundleError("请使用单一 src 图片；暂不支持 srcset。");
      if (item.name.startsWith("on")) compileScript(`function handler(event){${item.value}\n}`, "index.html inline handler", false);
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(document);
  let html = serialize(document);
  const fetchFiles = Object.fromEntries(artifact.files.map(file => [file.path, file.content]));
  // A local resource adapter, without granting access to network or host cookies.
  const adapter = `<script>(function(){var files=${JSON.stringify(fetchFiles).replace(/</g, "\\u003c")};window.fetch=function(input,init){var url=typeof input==='string'?input:(input.url||input.href);var method=(init&&init.method)||input.method||'GET';if(method!=='GET')return Promise.reject(new Error('Only local GET is supported'));try{var u=new URL(url,'https://arcane.invalid/');if(u.protocol==='data:'){var comma=u.href.indexOf(',');if(comma<0)throw new Error('Invalid data URL');var header=u.href.slice(5,comma),data=u.href.slice(comma+1),bytes;if(/;base64$/i.test(header)){var binary=atob(data);bytes=Uint8Array.from(binary,function(char){return char.charCodeAt(0);});}else{bytes=new TextEncoder().encode(decodeURIComponent(data));}return Promise.resolve(new Response(bytes,{status:200,headers:{'Content-Type':header.replace(/;base64$/i,'')||'text/plain'}}));}if(u.origin!=='https://arcane.invalid')throw new Error('Network is disabled');var path=decodeURIComponent(u.pathname.slice(1));if(!Object.prototype.hasOwnProperty.call(files,path))throw new Error('Local resource missing: '+path);return Promise.resolve(new Response(files[path],{status:200,headers:{'Content-Type':path.endsWith('.json')?'application/json':'text/plain'}}));}catch(error){return Promise.reject(error);}};})();</script>`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'">`;
  html = html.replace(/<head>/i, `<head>${csp}${adapter}`);
  return { html: boundedSource(html, "index.html"), referencedFiles: [...referenced].sort() };
}
