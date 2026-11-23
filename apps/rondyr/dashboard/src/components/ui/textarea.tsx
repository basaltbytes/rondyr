import { cn } from "cn";
import type { ComponentProps } from "react";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-md border border-border bg-input px-4 py-2.5 text-base transition-colors duration-150 ease-out placeholder:text-muted-foreground disabled:opacity-50 aria-invalid:border-destructive pointer-fine:text-sm",
        className,
      )}
      {...props}
    />
  );
}
