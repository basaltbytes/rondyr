import { cn } from "cn";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

const skeletonVariants = cva("animate-pulse bg-foreground/10 motion-reduce:animate-none", {
  variants: {
    variant: {
      default: "rounded-xs",
      circle: "rounded-full",
    },
  },
  defaultVariants: { variant: "default" },
});

interface SkeletonProps extends ComponentProps<"div">, VariantProps<typeof skeletonVariants> {}

/** Placeholder block shown while data or a screen loads. */
export function Skeleton({ className, variant, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(skeletonVariants({ variant }), className)}
      {...props}
    />
  );
}
