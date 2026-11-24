import { cn } from "cn";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

const badgeVariants = cva(
  "inline-flex h-5.5 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        neutral: "border-border bg-muted text-muted-foreground",
        warning: "border-warning/30 bg-warning-subtle text-warning",
        success: "border-success/30 bg-success-subtle text-success",
        destructive: "border-destructive/30 bg-destructive-subtle text-destructive",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

/** A status label. The dot repeats the color for people who read shape before text. */
export function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
