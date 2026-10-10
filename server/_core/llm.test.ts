import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./env", () => ({ ENV: { forgeApiKey: "test-only-placeholder", forgeApiUrl: "https://model.invalid", forgeModel: "mock" } }));
import { invokeLLM, listLLMModels } from "./llm";
beforeEach(() => { vi.restoreAllMocks(); });
describe("LLM deadline and recovery policy", () => {
  it("allows generation to account for every attempt without hidden transport retries", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("private-response", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(invokeLLM({ messages: [{ role: "user", content: "test" }], maxRetries: 0 })).rejects.toThrow("HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRejectedValue(new TypeError("network failed"));
    await expect(invokeLLM({ messages: [{ role: "user", content: "test" }], maxRetries: 0 })).rejects.toThrow("network failed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid retry limits and sanitizes model-list errors", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("private-response", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(invokeLLM({ messages: [], maxRetries: -1 })).rejects.toThrow("maxRetries");
    expect(fetch).not.toHaveBeenCalled();
    await expect(listLLMModels()).rejects.toThrow("HTTP 401");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry bad requests or expose provider error bodies", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("private-source-in-provider-error", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    await expect(invokeLLM({ messages: [{ role: "user", content: "test" }] })).rejects.toThrow("HTTP 400");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("passes cancellation to transport and stops before retry", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(init.signal?.reason)); controller.abort(new DOMException("cancelled", "AbortError")); }));
    vi.stubGlobal("fetch", fetch);
    await expect(invokeLLM({ messages: [{ role: "user", content: "test" }], signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("cancels retry backoff without consuming another model call", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(new Response("overloaded", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const result = invokeLLM({ messages: [{ role: "user", content: "test" }], signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException("cancelled", "AbortError")), 30);
    await expect(result).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
