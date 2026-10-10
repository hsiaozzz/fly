import type { CookieOptions, Request } from "express";

export function getSessionCookieOptions(req: Request): Pick<CookieOptions, "httpOnly" | "path" | "sameSite" | "secure"> {
  // Express evaluates forwarded protocol only for configured trusted proxies.
  const secure = req.secure === true || req.protocol === "https";
  return { httpOnly: true, path: "/", sameSite: secure ? "none" : "lax", secure };
}
