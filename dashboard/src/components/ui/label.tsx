import { cn } from "cn";
import type { ComponentProps } from "react";

/** The label of a field. `htmlFor` names the field it focuses. */
export function Label({ className, htmlFor, ...props }: ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      htmlFor={htmlFor}
      className={cn("flex items-center gap-2 text-sm leading-none font-medium", className)}
      {...props}
    />
  );
}
