import { cn } from "cn";
import type { ComponentProps } from "react";

/** A text field. Its text is 16px under a finger, so iOS does not zoom the page. */
export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-base transition-colors duration-150 ease-out placeholder:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive pointer-fine:text-sm pointer-coarse:h-11",
        className,
      )}
      {...props}
    />
  );
}
