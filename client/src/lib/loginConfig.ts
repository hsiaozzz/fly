/** Validate only public login settings; never mutate browser state here. */
export function loginEndpoint(portal: unknown, appId: unknown): URL | null {
  if (
    typeof portal !== "string" ||
    typeof appId !== "string" ||
    !portal.trim() ||
    !appId.trim() ||
    portal !== portal.trim() ||
    appId !== appId.trim() ||
    /[\u0000-\u001f\u007f]/.test(portal + appId)
  )
    return null;
  const placeholder =
    /(?:change[-_ ]?me|replace(?:[-_ ]|$)|your[-_ ]|placeholder|example\.(?:com|org|net)|\.invalid(?:\/|$))/i;
  if (placeholder.test(portal) || placeholder.test(appId)) return null;
  try {
    const url = new URL(portal.trim());
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /(?:^|\.)example$/i.test(url.hostname)
    )
      return null;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/app-auth`;
    return url;
  } catch {
    return null;
  }
}
