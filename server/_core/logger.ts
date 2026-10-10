/** Errors from SDKs may contain Authorization headers, signed URLs or source code. */
export function safeError(error: unknown): { name: string; status?: number } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const status = (error as Error & { response?: { status?: number }; statusCode?: number }).response?.status
    ?? (error as Error & { statusCode?: number }).statusCode;
  return { name: error.name, ...(typeof status === "number" ? { status } : {}) };
}

export function logError(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, ...safeError(error) }));
}
