import { memo } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  iconOnly = false,
  className,
}: {
  text: string;
  iconOnly?: boolean;
  className?: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>();

  return (
    <Button
      type="button"
      size={iconOnly ? "icon-sm" : "xs"}
      variant={iconOnly ? "ghost" : "outline"}
      className={cn(iconOnly && "rounded-full", className)}
      onClick={() => copyToClipboard(text, text)}
      title={isCopied ? "Copied" : "Copy message"}
      aria-label={isCopied ? "Copied" : "Copy message"}
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});
