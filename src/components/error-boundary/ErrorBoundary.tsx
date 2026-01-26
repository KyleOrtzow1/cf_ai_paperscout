import React, { Component, type ReactNode } from "react";
import { Card } from "@/components/card/Card";
import { Button } from "@/components/button/Button";
import { WarningCircleIcon } from "@phosphor-icons/react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

/**
 * React Error Boundary component
 *
 * Catches all unhandled errors in the React component tree below it.
 * Prevents the entire app from crashing and shows a user-friendly error UI.
 *
 * Note: Error boundaries do NOT catch:
 * - Errors in event handlers (use try-catch)
 * - Asynchronous code (use try-catch or .catch())
 * - Server-side rendering errors
 * - Errors thrown in the error boundary itself
 *
 * @example
 * <ErrorBoundary>
 *   <App />
 * </ErrorBoundary>
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log error details for debugging
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    this.setState({
      error,
      errorInfo
    });
  }

  handleReset = (): void => {
    // Reset error state and attempt to recover
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null
    });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-full p-4 flex justify-center items-center bg-fixed">
          <Card className="p-6 max-w-md mx-auto bg-neutral-100 dark:bg-neutral-900">
            <div className="space-y-4">
              {/* Error Icon */}
              <div className="bg-red-500/10 text-red-500 rounded-full p-3 inline-flex">
                <WarningCircleIcon size={24} weight="fill" />
              </div>

              {/* Error Message */}
              <div className="space-y-2">
                <h3 className="font-semibold text-lg">Something went wrong</h3>
                <p className="text-muted-foreground text-sm">
                  The application encountered an unexpected error. You can try
                  resetting the app or refresh the page.
                </p>
              </div>

              {/* Error Details (collapsed by default) */}
              {this.state.error && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-neutral-700 dark:hover:text-neutral-300">
                    Technical details
                  </summary>
                  <div className="mt-2 p-2 bg-neutral-200 dark:bg-neutral-800 rounded overflow-auto max-h-40">
                    <div className="font-mono">
                      <strong>Error:</strong> {this.state.error.message}
                    </div>
                    {this.state.errorInfo?.componentStack && (
                      <div className="font-mono mt-2">
                        <strong>Component Stack:</strong>
                        <pre className="whitespace-pre-wrap text-xs">
                          {this.state.errorInfo.componentStack}
                        </pre>
                      </div>
                    )}
                  </div>
                </details>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={this.handleReset}
                  className="flex-1"
                >
                  Try Again
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  onClick={() => window.location.reload()}
                  className="flex-1"
                >
                  Refresh Page
                </Button>
              </div>
            </div>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
