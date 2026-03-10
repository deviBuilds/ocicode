import { APP_BASE_NAME } from "@ocicode/shared/branding";
import { cn } from "~/lib/utils";

export function OciWordmark({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-label={APP_BASE_NAME}
      className={cn("h-3 w-auto shrink-0 text-foreground", className)}
      viewBox="0 0 176 28"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="18" height="22" rx="8" strokeWidth="3.2" />
        <path d="M50 7.5a9 9 0 1 0 0 13" strokeWidth="3.2" />
        <path d="M67 5v20" strokeWidth="3.2" />
      </g>
      <text
        x="82"
        y="19"
        fill="currentColor"
        fontFamily={'ui-sans-serif, "Avenir Next", "Segoe UI", sans-serif'}
        fontSize="13"
        fontWeight="700"
        letterSpacing="0.24em"
      >
        OCI CODE
      </text>
    </svg>
  );
}
