"use client";

import { useEffect } from "react";
import { ErrorState } from "../../../components/ErrorState";
import {
  getErrorMessage,
  reportFrontendError,
} from "../../../lib/frontend-error";

export default function ProposalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportFrontendError("proposal_route_error", error, {
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <ErrorState
        title="Failed to load proposal"
        message={`${getErrorMessage(error)} This is usually caused by a temporary RPC or indexer failure.`}
        onRetry={reset}
      />
    </div>
  );
}
