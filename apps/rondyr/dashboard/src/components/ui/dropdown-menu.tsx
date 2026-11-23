import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "cn";
import { Check } from "lucide-react";

export function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

export function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

interface DropdownMenuContentProps extends MenuPrimitive.Popup.Props {
  readonly side?: MenuPrimitive.Positioner.Props["side"];
  readonly align?: MenuPrimitive.Positioner.Props["align"];
}

/**
 * The menu scales from its trigger and leaves faster than it arrives. With
 * reduced motion it only fades.
 */
export function DropdownMenuContent({
  className,
  side,
  align,
  ...props
}: DropdownMenuContentProps) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side={side ?? "bottom"} align={align ?? "start"} sideOffset={6}>
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "max-h-(--available-height) w-(--anchor-width) min-w-72 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border bg-popover p-2 text-sm text-popover-foreground shadow-popover outline-hidden transition duration-150 ease-out data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:data-ending-style:scale-100 motion-reduce:data-starting-style:scale-100",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

/** A row of 40px, or 44px under a finger. The highlight is its focus indicator. */
const row =
  "flex min-h-10 cursor-default items-center gap-2 rounded-xs px-3 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-muted data-highlighted:text-foreground pointer-coarse:min-h-11";

export function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item data-slot="dropdown-menu-item" className={cn(row, className)} {...props} />
  );
}

/** A row that is a link: it opens or downloads its address, then the menu closes. */
export function DropdownMenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return (
    <MenuPrimitive.LinkItem
      data-slot="dropdown-menu-link-item"
      closeOnClick
      className={cn(row, className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-2 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

/** One choice of a group. The check at its end marks the current one. */
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(row, className)}
      {...props}
    >
      {children}
      <span className="flex size-4 shrink-0 items-center justify-center">
        <MenuPrimitive.RadioItemIndicator>
          <Check aria-hidden="true" className="size-4" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
    </MenuPrimitive.RadioItem>
  );
}
