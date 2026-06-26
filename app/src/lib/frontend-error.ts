"use client";

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return "Something went wrong.";
}

export function reportFrontendError(
  context: string,
  error: unknown,
  details?: Record<string, unknown>,
) {
  const payload = {
    context,
    message: getErrorMessage(error),
    name: error instanceof Error ? error.name : undefined,
    stack: error instanceof Error ? error.stack : undefined,
    details,
    timestamp: new Date().toISOString(),
  };

  console.error("[frontend-error]", payload);
  return payload;
}
