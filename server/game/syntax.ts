import vm from "node:vm";
import { parse } from "acorn";
import { activeScripts } from "../../shared/game/sourceEvidence";
import type { GameFile, GateCheck } from "../../shared/game/types";

/** Parse code without evaluating it in the server process. */
export function checkJavaScriptSyntax(files: GameFile[]): GateCheck {
  const errors: string[] = [];
  for (const script of activeScripts(files).scripts) {
    try {
      if (script.module) parse(script.content, { ecmaVersion: "latest", sourceType: "module", locations: true });
      else new vm.Script(script.content, { filename: script.path });
    } catch (error) {
      errors.push(`${script.path}: ${error instanceof Error ? error.message : "invalid JavaScript"}`);
    }
  }
  return errors.length
    ? { name: "javascript_syntax", label: "JavaScript语法", status: "fail", detail: errors.join("; "), hint: "修复指出的文件语法错误；源码验证不会执行任何代码。" }
    : { name: "javascript_syntax", label: "JavaScript语法", status: "pass", detail: "所有入口可达脚本的语法解析通过；尚未验证运行行为。" };
}
