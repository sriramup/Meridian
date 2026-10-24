import { cn } from "./cn";

/** A steady rotating arc (no pulsing or blinking). Inherits currentColor. */
export function Spinner({ size = 14, className, label = "Loading" }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      role="status"
      aria-label={label}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn("kit-spin shrink-0", className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.75" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}
