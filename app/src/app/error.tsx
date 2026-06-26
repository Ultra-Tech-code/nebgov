"use client";

import { useEffect } from "react";
import { ErrorState } from "../components/ErrorState";
import { getErrorMessage, reportFrontendError } from "../lib/frontend-error";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportFrontendError("root_route_error", error, {
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <ErrorState
        title="Something went wrong"
        message={`${getErrorMessage(error)} This is usually caused by a temporary RPC or indexer failure.`}
        onRetry={reset}
      />
    </div>
  );
}
"use client";

import { useEffect } from "react";
import { ErrorState } from "../components/ErrorState";
import { getErrorMessage, reportFrontendError } from "../lib/frontend-error";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportFrontendError("app_route_error", error, {
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <ErrorState
        title="Failed to load governance page"
        message={`${getErrorMessage(error)} Try again if the RPC or indexer issue was temporary.`}
        onRetry={reset}
      />
    </div>
  );
}
