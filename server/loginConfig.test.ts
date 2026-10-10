import { afterEach, describe, expect, it, vi } from "vitest";
import { loginEndpoint } from "../client/src/lib/loginConfig";
import { startLogin } from "../client/src/const";

vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("public login configuration", () => {
  it("rejects missing, placeholder and unsafe login targets", () => {
    for (const portal of [
      undefined,
      "",
      "not-a-url",
      "javascript:alert(1)",
      "https://example.com",
      "https://accounts.invalid",
      "https://replace-with-oauth-portal.example",
      "https://accounts.example",
      "https://replace-with-oauth-portal.arcane.test",
      "https://user:private@accounts.arcane.test",
      "https://accounts.arcane.test?private=value",
    ])
      expect(loginEndpoint(portal, "arcane-test-app")).toBeNull();
    expect(
      loginEndpoint("https://accounts.arcane.test", "your-app-id")
    ).toBeNull();
    expect(loginEndpoint("https://accounts.arcane.test", "")).toBeNull();
  });
  it("preserves a real portal base path without creating browser state", () => {
    expect(
      loginEndpoint("https://accounts.arcane.test/portal/", "arcane-test-app")
        ?.href
    ).toBe("https://accounts.arcane.test/portal/app-auth");
  });
  it.each([
    "https://accounts.invalid",
    "https://replace-with-oauth-portal.example",
  ])(
    "does not generate a nonce, write cookies or navigate with placeholder %s",
    portal => {
      vi.stubEnv("VITE_OAUTH_PORTAL_URL", portal);
      vi.stubEnv("VITE_APP_ID", "arcane-test-app");
      const document = { cookie: "original-cookie" };
      const window = { location: { href: "/original" } };
      const randomUUID = vi.fn();
      vi.stubGlobal("document", document);
      vi.stubGlobal("window", window);
      vi.stubGlobal("crypto", { randomUUID });
      expect(startLogin()).toBe(false);
      expect(randomUUID).not.toHaveBeenCalled();
      expect(document.cookie).toBe("original-cookie");
      expect(window.location.href).toBe("/original");
    }
  );
  it("starts a configured login with the nonce bound to the callback state", () => {
    vi.stubEnv("VITE_OAUTH_PORTAL_URL", "https://accounts.arcane.test");
    vi.stubEnv("VITE_APP_ID", "arcane-test-app");
    const document = { cookie: "" };
    const window = {
      location: {
        href: "/original",
        origin: "http://localhost:3000",
        protocol: "http:",
        hostname: "localhost",
      },
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("crypto", { randomUUID: () => "controlled-nonce" });
    expect(startLogin()).toBe(true);
    expect(document.cookie).toContain(
      "arcane_oauth_state_dev=controlled-nonce"
    );
    const target = new URL(window.location.href);
    expect(target.origin).toBe("https://accounts.arcane.test");
    expect(target.searchParams.get("appId")).toBe("arcane-test-app");
    expect(JSON.parse(atob(target.searchParams.get("state")!))).toEqual({
      redirectUri: "http://localhost:3000/api/oauth/callback",
      nonce: "controlled-nonce",
    });
  });
});
