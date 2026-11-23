import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "cn";

export function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

interface PopoverContentProps extends PopoverPrimitive.Popup.Props {
  readonly side?: PopoverPrimitive.Positioner.Props["side"];
  readonly align?: PopoverPrimitive.Positioner.Props["align"];
}

/**
 * A panel next to its trigger. It scales from the trigger and leaves faster
 * than it arrives. With reduced motion it only fades.
 */
export function PopoverContent({ className, side, align, ...props }: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side={side ?? "bottom"} align={align ?? "start"} sideOffset={6}>
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "max-h-(--available-height) origin-(--transform-origin) overflow-y-auto rounded-lg border bg-popover p-2 text-sm text-popover-foreground shadow-popover outline-hidden transition duration-150 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:data-ending-style:scale-100 motion-reduce:data-starting-style:scale-100",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

/** The name of the panel, which a screen reader announces when it opens. */
export function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}
