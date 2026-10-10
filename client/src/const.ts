import { OAUTH_STATE_COOKIE, encodeOAuthState } from "@shared/const";
import { toast } from "sonner";
import { loginEndpoint } from "./lib/loginConfig";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Start the Manus OAuth login. Call this from an event handler or effect at the
// moment you want to navigate, e.g. `onClick={() => startLogin()}`.
//
// It has SIDE EFFECTS — it mints a one-time nonce, writes the __Host- state
// cookie, and navigates immediately — so the cookie nonce always matches the
// `state` it sends. Do NOT call it during render (no `href={startLogin()}` /
// `loginUrl={...}`): each call overwrites the cookie, so a stray render-phase
// call would desync it from an in-flight login and the callback would reject it
// with "invalid oauth state". It returns whether navigation started, never a URL.
export const hasLoginConfiguration = () =>
  Boolean(
    loginEndpoint(
      import.meta.env.VITE_OAUTH_PORTAL_URL,
      import.meta.env.VITE_APP_ID
    )
  );
export const startLogin = () => {
  const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;
  const appId = import.meta.env.VITE_APP_ID;
  const url = loginEndpoint(oauthPortalUrl, appId);
  if (!url) {
    toast.info("此站点尚未开启账号登录。你可以继续使用本地草稿。");
    return false;
  }
  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  const nonce = crypto.randomUUID();
  const localHttp =
    window.location.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  document.cookie = localHttp
    ? `arcane_oauth_state_dev=${nonce}; Path=/; Max-Age=600; SameSite=Lax`
    : `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; Max-Age=600; SameSite=None; Secure`;
  const state = encodeOAuthState({ redirectUri, nonce });

  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  window.location.href = url.toString();
  return true;
};
