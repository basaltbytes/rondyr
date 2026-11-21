import { cn } from "cn";
import type { ComponentProps } from "react";

/** A message that needs attention now, such as a secret shown once. */
export function Alert({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(
        "grid w-full gap-1.5 rounded-lg bg-warning-subtle px-4 py-3 text-sm text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("grid justify-items-start gap-2 text-sm text-pretty", className)}
      {...props}
    />
  );
}
