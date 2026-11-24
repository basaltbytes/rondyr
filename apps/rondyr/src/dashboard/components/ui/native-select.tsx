import { cn } from "cn";
import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * A select with the frame of a text field. The browser draws its list; the
 * arrow is the dashboard's, set in from the rounded end of the field. Its text
 * is 16px under a finger, so iOS does not zoom the page. `className` sizes the
 * field.
 */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <div data-slot="native-select-wrapper" className={cn("relative w-full min-w-0", className)}>
      <select
        data-slot="native-select"
        className="h-10 w-full min-w-0 appearance-none truncate rounded-md border border-border bg-input py-1 pr-10 pl-4 text-base transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive pointer-fine:text-sm pointer-coarse:h-11"
        {...props}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
