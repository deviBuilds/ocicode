import * as React from "react";

export function useCopyToClipboard<TContext = void>({
  timeout = 2_000,
  onCopy,
  onError,
}: {
  timeout?: number;
  onCopy?: (context: TContext) => void;
  onError?: (error: Error, context: TContext) => void;
} = {}): {
  copyToClipboard: (value: string, context: TContext) => void;
  isCopied: boolean;
} {
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const timeoutRef = React.useRef(timeout);

  onCopyRef.current = onCopy;
  onErrorRef.current = onError;
  timeoutRef.current = timeout;

  const copyToClipboard = React.useCallback((value: string, context: TContext): void => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      onErrorRef.current?.(new Error("Clipboard API unavailable."), context);
      return;
    }
    if (!value) {
      return;
    }

    navigator.clipboard.writeText(value).then(
      () => {
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);
        onCopyRef.current?.(context);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        if (error instanceof Error) {
          onErrorRef.current?.(error, context);
          return;
        }
        onErrorRef.current?.(new Error("Clipboard write failed."), context);
      },
    );
  }, []);

  React.useEffect(() => {
    return () => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}
