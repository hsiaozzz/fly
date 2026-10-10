import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";

// Editor code and every worker ship with the application. Configuring the
// loader before mounting prevents its default external CDN request.
(
  self as typeof self & {
    MonacoEnvironment: { getWorker: (_: string, label: string) => Worker };
  }
).MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new JsonWorker();
    if (["css", "scss", "less"].includes(label)) return new CssWorker();
    if (["html", "handlebars", "razor"].includes(label))
      return new HtmlWorker();
    if (["typescript", "javascript"].includes(label))
      return new TypeScriptWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });

export default Editor;
