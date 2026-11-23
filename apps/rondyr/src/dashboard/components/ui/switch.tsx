import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "cn";

/**
 * A setting that is on or off, and takes effect at once. The track looks 20px
 * high; the pseudo-element keeps the target at 40px, 44px under a finger.
 */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative flex h-5 w-9 shrink-0 items-center rounded-full border border-muted-foreground bg-muted p-0.5 transition-colors duration-150 ease-out before:absolute before:-inset-x-1 before:-inset-y-2.5 data-checked:border-primary data-checked:bg-primary data-disabled:opacity-50 pointer-coarse:before:-inset-y-3",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="block size-3.5 rounded-full bg-muted-foreground transition-transform duration-150 ease-out data-checked:translate-x-4 data-checked:bg-primary-foreground motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  );
}
