import { memo } from "react";
import { type ServerProviderStatus } from "@ocicode/contracts";
import { CircleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProviderStatus | null;
}) {
  if (!status || status.status === "ready") {
    return null;
  }

  const defaultMessage =
    status.status === "error"
      ? `${status.provider} provider is unavailable.`
      : `${status.provider} provider has limited availability.`;

  return (
    <div className="mx-auto max-w-[57.5rem] px-4 pt-4 sm:px-6">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>
          {status.provider === "codex" ? "Codex provider status" : `${status.provider} status`}
        </AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
      </Alert>
    </div>
  );
});
