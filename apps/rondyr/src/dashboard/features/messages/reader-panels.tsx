import { Accordion } from "@base-ui/react/accordion";
import { cn } from "cn";
import { ChevronUp } from "lucide-react";
import { useId, type ReactNode } from "react";

/** The panels folded under a message. */
export type ReaderPanelName = "classification" | "deliveries";

interface ReaderPanelsProps {
  /** The open panel, or null when every panel is folded. */
  readonly open: ReaderPanelName | null;
  readonly onOpen: (panel: ReaderPanelName | null) => void;
  readonly children: ReactNode;
}

/**
 * The details of a message, folded at the foot of the reader, one open at a time. From
 * 64rem the reader has the height of the window: an open panel grows upward and the
 * message scrolls in the room left above it.
 */
export function ReaderPanels({ open, onOpen, children }: ReaderPanelsProps) {
  return (
    <Accordion.Root
      value={open === null ? [] : [open]}
      onValueChange={(value) => onOpen(value[0] ?? null)}
      className={cn(
        // Positioned, so its shadow falls over the text of the message and not under it.
        "relative flex shrink-0 flex-col hairline-t bg-card transition-shadow duration-200 empty:hidden lg:max-h-[min(75%,calc(100%-12rem))]",
        open !== null && "shadow-dock",
      )}
    >
      {children}
    </Accordion.Root>
  );
}

interface ReaderPanelProps {
  readonly value: ReaderPanelName;
  /** The name of the row, and of the open panel for a screen reader. */
  readonly title: string;
  /** What the panel holds in a few words, shown while it is folded. */
  readonly summary?: ReactNode;
  /** The buttons that act on the panel, shown while it is open. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

/**
 * One panel: a row with its title, then its content. The whole row opens and folds the
 * panel, except the buttons placed on it.
 */
export function ReaderPanel({ value, title, summary, actions, children }: ReaderPanelProps) {
  const summaryId = useId();
  return (
    <Accordion.Item
      value={value}
      className="group/panel flex shrink-0 flex-col not-first:hairline-t data-open:min-h-0 data-open:shrink"
    >
      <div className="relative shrink-0 transition-colors duration-150 hover:bg-foreground/3">
        <div className="flex h-11 max-w-3xl items-center gap-2 px-5">
          <Accordion.Header className="flex min-w-0 flex-1">
            <Accordion.Trigger
              aria-describedby={summary === undefined ? undefined : summaryId}
              className="flex min-w-0 flex-1 items-center gap-3 text-left text-sm outline-none after:absolute after:inset-0 after:cursor-pointer focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
            >
              <span className="shrink-0 font-semibold">{title}</span>
              {summary !== undefined && (
                // Read as the description of the button, so its name stays the title.
                <span
                  id={summaryId}
                  aria-hidden="true"
                  className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground group-data-open/panel:hidden"
                >
                  {summary}
                </span>
              )}
            </Accordion.Trigger>
          </Accordion.Header>
          {actions !== undefined && (
            <span className="relative hidden shrink-0 items-center gap-1 group-data-open/panel:flex">
              {actions}
            </span>
          )}
          <ChevronUp
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-open/panel:rotate-180 motion-reduce:transition-none"
          />
        </div>
      </div>
      <Accordion.Panel className="h-(--accordion-panel-height) min-h-0 overflow-y-auto overscroll-contain transition-panel-height data-ending-style:h-0 data-starting-style:h-0">
        <div className="grid max-w-3xl gap-4 px-5 pt-1 pb-6">{children}</div>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
