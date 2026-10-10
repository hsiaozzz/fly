import { z } from "zod";

const configurationStatuses = ["configured", "missing", "invalid", "placeholder"] as const;
export type ConfigurationStatus = typeof configurationStatuses[number];
const capabilityStateSchema = z.object({
  configured: z.boolean(),
  status: z.enum(configurationStatuses),
  verification: z.literal("unverified"),
}).strict().refine(value => value.configured === (value.status === "configured"));
const browserStateSchema = z.object({
  configured: z.boolean(),
  status: z.enum([...configurationStatuses, "automatic"]),
  verification: z.literal("unverified"),
}).strict().refine(value => value.configured === (value.status === "configured"));

/** Configuration exists, not proof of provider, database or sandbox health. */
export const appCapabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  generation: capabilityStateSchema,
  authentication: capabilityStateSchema,
  cloudProjects: capabilityStateSchema,
  browserQa: browserStateSchema,
  database: capabilityStateSchema,
  objectStorage: capabilityStateSchema,
}).strict();
export type AppCapabilities = z.infer<typeof appCapabilitiesSchema>;

type Configuration = Readonly<Record<string, string | undefined>>;
const invalidCharacters = /[\u0000-\u001f\u007f]/;
function placeholder(value: string): boolean {
  return /^(?:replace(?:[-_ ]|$)|change[-_ ]?me$|placeholder$|your[-_ ](?:api[-_ ]?key|secret|app[-_ ]?id|server[-_ ]?key)$)/i.test(value.trim());
}
function valueStatus(value: string | undefined, minLength = 1): ConfigurationStatus {
  if (!value?.trim()) return "missing";
  if (placeholder(value)) return "placeholder";
  if (value !== value.trim() || invalidCharacters.test(value) || value.length < minLength) return "invalid";
  return "configured";
}
function placeholderHost(hostname: string): boolean {
  return /(?:^|\.)example$|(?:^|\.)invalid$|(?:^|\.)example\.(?:com|net|org)$/.test(hostname)
    || placeholder(hostname);
}
function urlStatus(value: string | undefined, database = false): ConfigurationStatus {
  const status = valueStatus(value);
  if (status !== "configured") return status;
  try {
    const url = new URL(value!);
    if (!url.hostname || (database ? url.protocol !== "mysql:" : !["http:", "https:"].includes(url.protocol))) return "invalid";
    if (placeholderHost(url.hostname)) return "placeholder";
    if (database) {
      const username = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      const databaseName = decodeURIComponent(url.pathname.slice(1));
      if (placeholder(username) || placeholder(password) || placeholder(databaseName)) return "placeholder";
      if (!databaseName || invalidCharacters.test(username + password + databaseName)) return "invalid";
    } else if (url.username || url.password) return "invalid";
    return "configured";
  } catch { return "invalid"; }
}
function combine(...statuses: ConfigurationStatus[]): ConfigurationStatus {
  for (const status of ["missing", "invalid", "placeholder"] as const) if (statuses.includes(status)) return status;
  return "configured";
}
function state<S extends ConfigurationStatus | "automatic">(status: S) {
  return { configured: status === "configured", status, verification: "unverified" as const };
}

/** Same installed-browser candidates used by the isolated QA worker. */
export function systemBrowserCandidates(platform: string): string[] {
  return platform === "win32"
    ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
}

/** Pure, local-only inspection. No input value is copied into the result. */
export function deriveAppCapabilities(configuration: Configuration, browserExecutableDetected = false): AppCapabilities {
  const provider = combine(urlStatus(configuration.BUILT_IN_FORGE_API_URL), valueStatus(configuration.BUILT_IN_FORGE_API_KEY));
  const database = urlStatus(configuration.DATABASE_URL, true);
  // The front end must independently validate its build-time login portal and
  // project identifier; server environment cannot attest to the built bundle.
  const authentication = combine(database, urlStatus(configuration.OAUTH_SERVER_URL), valueStatus(configuration.VITE_APP_ID), valueStatus(configuration.JWT_SECRET, 32));
  const browserSetting = valueStatus(configuration.ARCANE_BROWSER_EXECUTABLE);
  const browser = browserSetting === "missing"
    ? state(browserExecutableDetected ? "configured" : "automatic")
    : state(browserSetting === "configured" && !browserExecutableDetected ? "missing" : browserSetting);
  return {
    schemaVersion: 1,
    generation: state(provider),
    authentication: state(authentication),
    cloudProjects: state(combine(database, provider)),
    browserQa: browser,
    database: state(database),
    objectStorage: state(provider),
  };
}
