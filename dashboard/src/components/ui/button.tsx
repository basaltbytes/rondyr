import { cn } from "cn";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap transition duration-150 ease-out select-none active:scale-97 disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        // A filled secondary button: it stays visible on a card and on the page.
        outline: "bg-muted text-foreground shadow-raised hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
      },
      size: {
        // 40px with a mouse, 44px under a finger.
        default: "h-10 px-3.5 pointer-coarse:h-11",
        // Looks 32px; the pseudo-element keeps the target at 40px.
        sm: "relative h-8 px-2.5 before:absolute before:inset-x-0 before:-inset-y-1 pointer-coarse:h-11",
        icon: "size-10 pointer-coarse:size-11",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type, ...props }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
