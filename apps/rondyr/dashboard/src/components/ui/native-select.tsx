import { cn } from "cn";
import type { ComponentProps } from "react";

/**
 * A select drawn by the browser, with the frame of a text field. Its text is
 * 16px under a finger, so iOS does not zoom the page.
 */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 py-1 text-base transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive pointer-fine:text-sm pointer-coarse:h-11",
        className,
      )}
      {...props}
    />
  );
}
