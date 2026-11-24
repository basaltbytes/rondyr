import { createLink } from "@tanstack/react-router";
import { cn } from "cn";
import { PanelLeft } from "lucide-react";
import { createContext, use, useEffect, useState } from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { useIsMobile } from "~/hooks/use-mobile";

const storageKey = "rondyr-sidebar";
const shortcutKey = "b";

// The stored choice is read before the first paint, so the sidebar never flashes open.
function storedOpen() {
  try {
    return window.localStorage.getItem(storageKey) !== "collapsed";
  } catch {
    return true;
  }
}

function storeOpen(open: boolean) {
  try {
    window.localStorage.setItem(storageKey, open ? "expanded" : "collapsed");
  } catch {
    // Without storage the choice lasts until the page reloads.
  }
}

function modifierLabel() {
  return /mac|iphone|ipad/iu.test(window.navigator.userAgent) ? "⌘" : "Ctrl+";
}

interface SidebarState {
  /** The sidebar shows icons only. Never true in the drawer of a narrow screen. */
  readonly collapsed: boolean;
  readonly isMobile: boolean;
  readonly openMobile: boolean;
  readonly setOpenMobile: (open: boolean) => void;
  readonly toggleSidebar: () => void;
}

const SidebarContext = createContext<SidebarState | null>(null);

export function useSidebar() {
  const context = use(SidebarContext);
  if (context === null) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

export function SidebarProvider({ className, children, ...props }: ComponentProps<"div">) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(storedOpen);
  const [openMobile, setOpenMobile] = useState(false);

  function toggleSidebar() {
    if (isMobile) {
      setOpenMobile((current) => !current);
      return;
    }
    setOpen((current) => {
      const next = !current;
      storeOpen(next);
      return next;
    });
  }

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Listens to the window's keyboard for the sidebar shortcut.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== shortcutKey || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (isMobile) {
        setOpenMobile((current) => !current);
        return;
      }
      setOpen((current) => {
        const next = !current;
        storeOpen(next);
        return next;
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile]);

  return (
    <SidebarContext
      value={{ collapsed: !isMobile && !open, isMobile, openMobile, setOpenMobile, toggleSidebar }}
    >
      <TooltipProvider>
        <div
          data-slot="sidebar-wrapper"
          className={cn("flex min-h-svh w-full text-sm", className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext>
  );
}

interface SidebarProps {
  /** The name of the navigation, read by a screen reader. */
  readonly label: string;
  readonly children: ReactNode;
}

/**
 * The navigation of the app. A wide screen shows it as a column that collapses
 * to icons, without animating its width. A narrow screen shows it as a drawer.
 */
export function Sidebar({ label, children }: SidebarProps) {
  const { collapsed, isMobile, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent surface="sidebar" data-slot="sidebar" data-mobile="true">
          <SheetTitle className="sr-only">{label}</SheetTitle>
          {children}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      data-slot="sidebar"
      data-state={collapsed ? "collapsed" : "expanded"}
      aria-label={label}
      className={cn(
        "flex h-dvh shrink-0 flex-col bg-sidebar hairline-r border-sidebar-border text-sidebar-foreground",
        collapsed ? "w-14" : "w-60",
      )}
    >
      {children}
    </aside>
  );
}

/** Opens the drawer on a narrow screen, and collapses the sidebar to icons on a wide one. */
export function SidebarTrigger({ className }: Pick<ComponentProps<"button">, "className">) {
  const { t } = useTranslation();
  const { collapsed, isMobile, openMobile, toggleSidebar } = useSidebar();
  const trigger = (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      aria-label={t("sidebar.toggle")}
      aria-expanded={isMobile ? openMobile : !collapsed}
      className={className}
      onClick={toggleSidebar}
    >
      <PanelLeft aria-hidden="true" className="size-4" />
    </Button>
  );
  if (isMobile) return trigger;
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent side="bottom">
        {t("sidebar.menu")} <kbd className="font-sans opacity-70">{modifierLabel()}B</kbd>
      </TooltipContent>
    </Tooltip>
  );
}

export function SidebarInset({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="sidebar-inset" className={cn("min-w-0 flex-1", className)} {...props} />;
}

export function SidebarHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn(
        "flex flex-col gap-2 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: ComponentProps<"nav">) {
  return (
    <nav
      data-slot="sidebar-group"
      className={cn("flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  );
}

/** The title of a group. It keeps its height when the sidebar collapses, so the items do not jump. */
export function SidebarGroupLabel({ className, children, ...props }: ComponentProps<"p">) {
  const { collapsed } = useSidebar();
  return (
    <p
      data-slot="sidebar-group-label"
      className={cn(
        "flex h-8 items-center px-3 text-xs font-medium tracking-wider text-sidebar-foreground/60 uppercase",
        className,
      )}
      {...props}
    >
      <span className={cn(collapsed && "sr-only")}>{children}</span>
    </p>
  );
}

export function SidebarMenu({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  );
}

export function SidebarMenuItem({ className, ...props }: ComponentProps<"li">) {
  return <li data-slot="sidebar-menu-item" className={cn("relative", className)} {...props} />;
}

interface MenuRowProps {
  /** The page this item opens is the current one. */
  readonly active?: boolean | undefined;
  /** A row of the item's sub-menu is the current page. */
  readonly activeWithin?: boolean | undefined;
  /** Leaves room at the end of the row for a `SidebarMenuAction`. */
  readonly hasAction?: boolean | undefined;
  /** A row of a `SidebarMenuSub`, in a lighter weight than the item above it. */
  readonly nested?: boolean | undefined;
  /** `lg` holds two lines of text next to a square mark. */
  readonly size?: "default" | "lg" | undefined;
  /** Shown next to the icon while the sidebar is collapsed. */
  readonly tooltip?: string | undefined;
}

/**
 * A row of 40px, 44px under a finger. Its weight never changes: the current
 * page is told by its surface, so the labels do not shift. The row starts with
 * a mark of 32px, a `SidebarMenuIcon` or an avatar, so every label starts on
 * the same line and no mark moves when the sidebar collapses.
 */
function menuRowClass(
  { active, activeWithin, hasAction, nested, size }: MenuRowProps,
  collapsed: boolean,
) {
  return cn(
    "flex w-full items-center gap-2.5 overflow-hidden rounded-md text-start text-sm transition-colors duration-150 ease-out select-none focus-visible:outline-sidebar-ring disabled:pointer-events-none disabled:opacity-50",
    nested === true ? "font-normal" : "font-medium",
    size === "lg" ? "h-12" : "h-10 pointer-coarse:h-11",
    collapsed ? "justify-center px-0" : "pr-3 pl-1",
    hasAction === true && !collapsed && "pr-8 pointer-coarse:pr-11",
    active === true
      ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-xs"
      : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground",
    active !== true &&
      (activeWithin === true ? "text-sidebar-foreground" : "text-sidebar-foreground/75"),
  );
}

/** A row with the name of its page beside its icon while the sidebar is collapsed. */
interface WithTooltipProps {
  readonly row: ReactElement;
  readonly tooltip: string | undefined;
}

function WithTooltip({ row, tooltip }: WithTooltipProps) {
  const { collapsed } = useSidebar();
  if (!collapsed || tooltip === undefined) return row;
  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent side="right">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

interface SidebarMenuButtonProps extends ComponentProps<"button">, MenuRowProps {}

/** A row that acts on the page, such as the trigger of a menu. */
export function SidebarMenuButton({
  active,
  activeWithin,
  hasAction,
  nested,
  size,
  tooltip,
  className,
  type,
  ...props
}: SidebarMenuButtonProps) {
  const { collapsed } = useSidebar();
  const row = (
    <button
      type={type ?? "button"}
      data-slot="sidebar-menu-button"
      aria-current={active === true ? "page" : undefined}
      className={cn(
        menuRowClass({ active, activeWithin, hasAction, nested, size }, collapsed),
        className,
      )}
      {...props}
    />
  );
  return <WithTooltip row={row} tooltip={tooltip} />;
}

interface SidebarMenuAnchorProps extends ComponentProps<"a">, MenuRowProps {}

function SidebarMenuAnchor({
  active,
  activeWithin,
  hasAction,
  nested,
  size,
  tooltip,
  className,
  children,
  ...props
}: SidebarMenuAnchorProps) {
  const { collapsed } = useSidebar();
  const row = (
    <a
      data-slot="sidebar-menu-button"
      className={cn(
        menuRowClass({ active, activeWithin, hasAction, nested, size }, collapsed),
        className,
      )}
      {...props}
      aria-current={active === true ? "page" : undefined}
    >
      {children}
    </a>
  );
  return <WithTooltip row={row} tooltip={tooltip} />;
}

/** A row that opens a page of the dashboard: a link, which has the address of the page. */
export const SidebarMenuLink = createLink(SidebarMenuAnchor);

/**
 * A control at the end of a menu item, over its row, which leaves it room with
 * `hasAction`. Its icon sits at the end of a target of 40px, 44px under a finger.
 * The collapsed sidebar has no room for it.
 */
export function SidebarMenuAction({ className, type, ...props }: ComponentProps<"button">) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return (
    <button
      type={type ?? "button"}
      data-slot="sidebar-menu-action"
      className={cn(
        "absolute top-0 right-0 flex size-10 items-center justify-end rounded-md pr-3.5 text-sidebar-foreground/70 transition-colors duration-150 ease-out hover:text-sidebar-foreground focus-visible:outline-sidebar-ring pointer-coarse:size-11 pointer-coarse:justify-center pointer-coarse:pr-0",
        className,
      )}
      {...props}
    />
  );
}

/** The rows under a menu item, set in from it along a rule. */
export function SidebarMenuSub({ className, ...props }: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      className={cn(
        "mt-0.5 ml-4.5 flex min-w-0 flex-col gap-0.5 hairline-l border-sidebar-border pl-2",
        className,
      )}
      {...props}
    />
  );
}

/** The icon of a menu button, centered in the 32px that an avatar fills. */
export function SidebarMenuIcon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="sidebar-menu-icon"
      className={cn("flex size-8 shrink-0 items-center justify-center", className)}
      {...props}
    />
  );
}

/** The text of a menu button. Collapsed, it stays as the button's accessible name only. */
export function SidebarMenuLabel({ className, ...props }: ComponentProps<"span">) {
  const { collapsed } = useSidebar();
  return (
    <span
      data-slot="sidebar-menu-label"
      className={cn(collapsed ? "sr-only" : "min-w-0 flex-1 truncate", className)}
      {...props}
    />
  );
}

/**
 * A count or a mark at the end of a menu button, centered in a box of 20px so
 * the ends of the rows share an axis. Its digits have equal width.
 */
export function SidebarMenuBadge({ className, ...props }: ComponentProps<"span">) {
  const { collapsed } = useSidebar();
  if (collapsed) return null;
  return (
    <span
      data-slot="sidebar-menu-badge"
      className={cn(
        "flex h-5 min-w-5 shrink-0 items-center justify-center text-xs tabular-nums",
        className,
      )}
      {...props}
    />
  );
}
