"use client";

import React, { type ErrorInfo, type ReactNode } from "react";
import { getErrorMessage, reportFrontendError } from "../lib/frontend-error";
import { ErrorState } from "./ErrorState";

interface ErrorBoundaryProps {
  children: ReactNode;
  title: string;
  fallbackMessage?: string;
  resetKeys?: unknown[];
  className?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function resetKeysChanged(
  prevResetKeys: unknown[] = [],
  nextResetKeys: unknown[] = [],
) {
  if (prevResetKeys.length !== nextResetKeys.length) {
    return true;
  }

  return prevResetKeys.some((value, index) => value !== nextResetKeys[index]);
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportFrontendError("component_boundary", error, {
      title: this.props.title,
      componentStack: info.componentStack,
    });
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (
      this.state.error &&
      resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)
    ) {
      this.setState({ error: null });
    }
  }

  private handleReset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          title={this.props.title}
          message={
            this.props.fallbackMessage || getErrorMessage(this.state.error)
          }
          onRetry={this.handleReset}
          className={this.props.className}
        />
      );
    }

    return this.props.children;
  }
}
