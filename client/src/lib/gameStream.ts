import { COOKIE_NAME } from "@shared/const";

export type StreamEvent = { event: string; data: unknown };

/** Incremental SSE decoder, including CRLF, multiline data, UTF-8 chunks and an EOF tail. */
export class GameEventDecoder {
  private decoder = new TextDecoder();
  private buffer = "";
  private eventName = "message";
  private data: string[] = [];

  feed(value?: Uint8Array, end = false): StreamEvent[] {
    this.buffer += this.decoder.decode(value, { stream: !end });
    const events: StreamEvent[] = [];
    const dispatch = () => {
      if (this.data.length)
        events.push({
          event: this.eventName,
          data: JSON.parse(this.data.join("\n")),
        });
      this.eventName = "message";
      this.data = [];
    };
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) dispatch();
      else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const fieldValue =
          colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") this.eventName = fieldValue;
        if (field === "data") this.data.push(fieldValue);
      }
    }
    if (end) {
      if (this.buffer) {
        const tail = this.buffer.replace(/\r$/, "");
        if (tail.startsWith("data:"))
          this.data.push(tail.slice(5).replace(/^ /, ""));
        this.buffer = "";
      }
      dispatch();
    }
    return events;
  }
}

export function gameRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  try {
    const pair = sessionStorage
      .getItem("manus-cookie")
      ?.split(";")
      .find(value => value.trim().startsWith(`${COOKIE_NAME}=`));
    const token = pair?.trim().slice(COOKIE_NAME.length + 1);
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* Browser storage can be unavailable. Cookie authentication still works. */
  }
  return headers;
}

export async function readGameStream(
  body: Record<string, unknown>,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => Promise<void> | void
): Promise<void> {
  const response = await fetch("/api/game/stream", {
    method: "POST",
    credentials: "include",
    headers: gameRequestHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const error = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new Error(
      error?.error ?? error?.message ?? `请求失败 (${response.status})`
    );
  }
  const reader = response.body.getReader();
  const decoder = new GameEventDecoder();
  let terminal = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      for (const event of decoder.feed(value, done)) {
        if (signal.aborted)
          throw new DOMException("Request aborted", "AbortError");
        await onEvent(event);
        if (["complete", "clarify", "error"].includes(event.event))
          terminal = true;
      }
      if (done) break;
    }
    if (!terminal)
      throw new Error("连接在生成完成前中断。草稿已保留，请重试。");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
