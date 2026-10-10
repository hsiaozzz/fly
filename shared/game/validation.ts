export type ValidationScope = "build" | "runtime" | "input" | "acceptance" | "visual" | "performance";
export type ValidationCheck = {
  id: string;
  label: string;
  scope: ValidationScope;
  status: "pass" | "fail" | "warn" | "unverified";
  detail: string;
};

/** Signed server evidence is separate from the untrusted in-game probe. */
export type ValidationReport = {
  schemaVersion: 1;
  artifactHash: string;
  status: "passed" | "failed" | "unverified";
  environment: { runner: "playwright"; browser?: string; viewport: { width: number; height: number }; seed: number };
  checks: ValidationCheck[];
  errors: string[];
  durationMs: number;
  testedAt: string;
  evidence?: { screenshotDataUrl?: string };
};
