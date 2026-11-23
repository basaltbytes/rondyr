import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";

export function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

interface SheetContentProps extends SheetPrimitive.Popup.Props {
  /** `sidebar` matches the dark navigation surface when the sidebar opens as a drawer. */
  readonly surface?: "default" | "sidebar";
}

/**
 * A panel that slides in from the left over a dimmed page. The panel and the
 * backdrop share one duration, and with reduced motion both only fade.
 */
export function SheetContent({ className, surface, children, ...props }: SheetContentProps) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop
        data-slot="sheet-overlay"
        className="fixed inset-0 bg-scrim transition-opacity duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0"
      />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 left-0 flex h-full w-72 max-w-full flex-col pl-[env(safe-area-inset-left)] text-sm shadow-popover outline-hidden transition duration-200 ease-out data-ending-style:-translate-x-full data-starting-style:-translate-x-full motion-reduce:data-ending-style:translate-x-0 motion-reduce:data-ending-style:opacity-0 motion-reduce:data-starting-style:translate-x-0 motion-reduce:data-starting-style:opacity-0",
          surface === "sidebar"
            ? "border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
            : "bg-background text-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

export function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-base font-semibold", className)}
      {...props}
    />
  );
}
