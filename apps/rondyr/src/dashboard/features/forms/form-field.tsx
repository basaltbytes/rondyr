import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

import { FormFailureNote } from "./form-problems.tsx";
import type { FormFailure } from "./form-problems.tsx";

interface FieldProps {
  readonly label: string;
  /** The ID of the control that the label focuses. A setting of several controls has none. */
  readonly htmlFor?: string;
  /** Help shown under the control. */
  readonly hint?: ReactNode;
  /** The ID of the help, for the `aria-describedby` of the control. */
  readonly hintId?: string;
  readonly children: ReactNode;
}

/** A setting of a form: its name beside its control from 40rem, above it under that. */
export function Field({ label, htmlFor, hint, hintId, children }: FieldProps) {
  const content = (
    <div className="grid min-w-0 grid-cols-1 gap-1.5">
      {children}
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-pretty text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
  if (htmlFor !== undefined) {
    return (
      <div className="grid gap-x-6 gap-y-1.5 sm:field-columns">
        <Label htmlFor={htmlFor} className="sm:h-10">
          {label}
        </Label>
        {content}
      </div>
    );
  }
  return (
    <div className="grid gap-x-6 gap-y-1.5 sm:field-columns">
      <p className="flex items-center text-sm leading-none font-medium sm:h-10">{label}</p>
      {content}
    </div>
  );
}

interface SavingInputProps {
  readonly id: string;
  /** The saved text, or null when the setting has none. */
  readonly value: string | null;
  readonly placeholder: string;
  readonly type?: "text" | "url";
  readonly maxLength: number;
  /** The ID of the help of the field. */
  readonly hintId: string;
  /** Saves the text, or clears the setting with null, and returns why it failed. */
  readonly onSave: (value: string | null) => Promise<FormFailure | null>;
  /** The message for a failure that the API does not explain. */
  readonly fallback: string;
}

/**
 * A field that saves when the reader leaves it or presses Enter, and clears the
 * setting when it is left empty. A refused text stays in the field, next to why.
 */
export function SavingInput({
  id,
  value,
  placeholder,
  type,
  maxLength,
  hintId,
  onSave,
  fallback,
}: SavingInputProps) {
  const { t } = useTranslation();
  const problem = useId();
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [failure, setFailure] = useState<FormFailure | null>(null);

  async function save(text: string) {
    const next = text.trim();
    if (next === (value ?? "")) {
      setFailure(null);
      return;
    }
    setState("saving");
    const failed = await onSave(next === "" ? null : next);
    setFailure(failed);
    setState(failed === null ? "saved" : "idle");
  }

  return (
    <form
      className="grid gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }}
    >
      <div className="relative">
        <Input
          // The field shows the saved text again once the form is read anew.
          key={value ?? ""}
          id={id}
          type={type ?? "text"}
          defaultValue={value ?? ""}
          placeholder={placeholder}
          maxLength={maxLength}
          autoComplete="off"
          spellCheck={false}
          disabled={state === "saving"}
          aria-invalid={failure !== null || undefined}
          aria-describedby={failure === null ? hintId : `${problem} ${hintId}`}
          onBlur={(event) => void save(event.currentTarget.value)}
        />
        <output className="pointer-events-none absolute inset-y-1 right-1 flex items-center rounded-full bg-input px-2.5 text-success empty:hidden">
          {state === "saved" && (
            <>
              <Check aria-hidden="true" className="size-4" />
              <span className="sr-only">{t("common.saved")}</span>
            </>
          )}
        </output>
      </div>
      <FormFailureNote id={problem} failure={failure} fallback={fallback} />
    </form>
  );
}

interface CopyButtonProps {
  readonly text: string;
  readonly label: string;
  /** The name of the button once the text is in the clipboard. */
  readonly copiedLabel: string;
}

/** Copies a text. Its icon and its name say when the text is in the clipboard. */
export function CopyButton({ text, label, copiedLabel }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? copiedLabel : label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-4" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
    </Button>
  );
}
