import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * A text of several lines. Its corners have the curve of the ends of an input, which a
 * box of several lines takes without cutting into the first and last lines.
 */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-xs border border-border bg-input px-4 py-2.5 text-base transition-colors duration-150 ease-out placeholder:text-muted-foreground disabled:opacity-50 aria-invalid:border-destructive pointer-fine:text-sm",
        className,
      )}
      {...props}
    />
  );
}
