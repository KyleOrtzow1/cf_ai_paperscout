import { Card } from "@/components/card/Card";
import { XIcon, WarningIcon } from "@phosphor-icons/react";

interface ErrorNotificationProps {
  message: string;
  onDismiss?: () => void;
}

/**
 * Inline error notification component
 *
 * Displays error messages inline within the UI (not as a toast).
 * Used for displaying message send errors and other recoverable errors.
 *
 * @example
 * {sendError && (
 *   <ErrorNotification
 *     message={sendError}
 *     onDismiss={() => setSendError(null)}
 *   />
 * )}
 */
export function ErrorNotification({
  message,
  onDismiss
}: ErrorNotificationProps) {
  return (
    <Card className="mt-2 p-3 bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900">
      <div className="flex items-start gap-2">
        <WarningIcon
          size={16}
          weight="fill"
          className="text-red-500 shrink-0 mt-0.5"
        />
        <p className="text-sm text-red-700 dark:text-red-400 flex-1">
          {message}
        </p>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-red-500 hover:text-red-700 dark:hover:text-red-300 shrink-0"
            aria-label="Dismiss error"
          >
            <XIcon size={16} weight="bold" />
          </button>
        )}
      </div>
    </Card>
  );
}
