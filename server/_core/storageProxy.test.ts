import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
const mocked = vi.hoisted(() => ({ ownership: vi.fn(), context: vi.fn(), signing: vi.fn() }));
vi.mock("../db", () => ({ canReadStorageObject: mocked.ownership }));
vi.mock("./context", () => ({ createContext: mocked.context }));
vi.mock("../storage", async importOriginal => ({ ...await importOriginal<typeof import("../storage")>(), storageGetSignedUrl: mocked.signing }));
import { registerStorageProxy } from "./storageProxy";
function setup(key: string) {
  let handler: (req: Request, res: Response) => Promise<void>;
  const app = { get: (_path: string, fn: typeof handler) => { handler = fn; } };
  registerStorageProxy(app as unknown as Express);
  const res = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), redirect: vi.fn() };
  return { run: () => handler({ params: { 0: key } } as unknown as Request, res as unknown as Response), res };
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("PUBLIC_STORAGE_KEYS", "branding/logo.svg"); vi.stubEnv("VITE_APP_LOGO", ""); mocked.signing.mockResolvedValue("https://objects.example/test"); });
describe("private storage authorization", () => {
  it("never signs a private object for an anonymous visitor", async () => {
    mocked.context.mockResolvedValue({ user: null }); const fixture = setup("game-projects/1/1/archive.zip");
    await fixture.run(); expect(fixture.res.status).toHaveBeenCalledWith(404); expect(mocked.signing).not.toHaveBeenCalled(); expect(mocked.ownership).not.toHaveBeenCalled();
  });
  it("does not infer ownership from a guessed path", async () => {
    mocked.context.mockResolvedValue({ user: { id: 2 } }); mocked.ownership.mockResolvedValue(false);
    const fixture = setup("game-projects/2/1/archive.zip"); await fixture.run();
    expect(mocked.ownership).toHaveBeenCalledWith(2, "game-projects/2/1/archive.zip"); expect(mocked.signing).not.toHaveBeenCalled(); expect(fixture.res.status).toHaveBeenCalledWith(404);
  });
  it("signs only after the database ownership check succeeds", async () => {
    mocked.context.mockResolvedValue({ user: { id: 2 } }); mocked.ownership.mockResolvedValue(true);
    const fixture = setup("game-projects/2/1/archive.zip"); await fixture.run();
    expect(fixture.res.redirect).toHaveBeenCalledWith(307, "https://objects.example/test");
    expect(fixture.res.set).toHaveBeenCalledWith(expect.objectContaining({ "Cache-Control": "private, no-store" }));
  });
  it("allows exact public assets without allowing prefix neighbors", async () => {
    const fixture = setup("branding/logo.svg"); await fixture.run(); expect(fixture.res.redirect).toHaveBeenCalled(); expect(mocked.context).not.toHaveBeenCalled();
    mocked.context.mockResolvedValue({ user: null }); const neighbor = setup("branding/logo.svg/private.zip"); await neighbor.run(); expect(neighbor.res.status).toHaveBeenCalledWith(404);
  });
});
