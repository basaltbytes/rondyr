import { cn } from "cn";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import type { ManagedForm } from "~/lib/api/forms";

/** The emoji of a form that has none yet. */
const defaultEmoji = "📄";

/** The emoji that the dashboard shows next to the name of a form. */
export function emojiOf(form: Pick<ManagedForm, "emoji">) {
  return form.emoji ?? defaultEmoji;
}

// The choices of the picker. The API accepts any single emoji.
const choices = [
  ["📮", "✉️", "📬", "💬", "📝", "🧾", "📋", "📎"],
  ["📣", "📰", "🛟", "🆘", "🔧", "🤝", "💼", "🏢"],
  ["🏪", "🛒", "💳", "💶", "📦", "🚚", "🎟️", "📅"],
  ["🎓", "🧪", "🚀", "⭐", "❤️", "🌱", "🍽️", "☕"],
  ["🏠", "🏥", "⚖️", "🎨", "📷", "🎧", "🐾", "✈️"],
  ["🏋️", "🔒", "🏺", defaultEmoji],
].flat();

interface FormEmojiProps {
  readonly form: Pick<ManagedForm, "emoji">;
  readonly className?: string;
}

/** The emoji of a form in the box of a 16px icon. The name next to it says which form it is. */
export function FormEmoji({ form, className }: FormEmojiProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center text-base leading-none",
        className,
      )}
    >
      {emojiOf(form)}
    </span>
  );
}

interface EmojiPickerProps {
  /** The emoji shown, and marked in the grid. */
  readonly value: string;
  readonly onChange: (emoji: string) => void;
  readonly disabled?: boolean;
  /** `lg` is the mark at the top of a form's page. */
  readonly size?: "default" | "lg";
}

/** The emoji of a form, and a grid to pick another one. */
export function EmojiPicker({ value, onChange, disabled, size }: EmojiPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("inbox.forms.emoji.change")}
            disabled={disabled}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md leading-none transition-colors duration-150 ease-out hover:bg-muted disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-muted",
              // The emoji has the padding of the texts edited in place under it on the page.
              size === "lg"
                ? "h-16 w-18 text-5xl sm:w-20"
                : "size-10 text-2xl pointer-coarse:size-11",
            )}
          />
        }
      >
        <span aria-hidden="true">{value}</span>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverTitle>{t("inbox.forms.emoji.label")}</PopoverTitle>
        <div className="grid grid-cols-8 gap-0.5">
          {choices.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-pressed={emoji === value}
              className={cn(
                "flex size-10 items-center justify-center rounded-full text-xl leading-none transition-colors duration-150 ease-out pointer-coarse:size-11",
                emoji === value ? "bg-primary/20" : "hover:bg-muted",
              )}
              onClick={() => {
                setOpen(false);
                if (emoji !== value) onChange(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
