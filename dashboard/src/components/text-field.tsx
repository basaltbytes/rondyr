import { cn } from "cn";
import { useId } from "react";
import type { ComponentProps, ReactNode } from "react";

import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

interface FieldFrameProps {
  readonly id: string;
  readonly label: string;
  /** Help shown under the field. */
  readonly hint: ReactNode;
  readonly className: string | undefined;
  readonly children: ReactNode;
}

function FieldFrame({ id, label, hint, className, children }: FieldFrameProps) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint !== undefined && hint !== null && (
        <p id={`${id}-hint`} className="text-xs text-pretty text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

interface TextFieldProps extends ComponentProps<"input"> {
  readonly label: string;
  readonly hint?: ReactNode;
}

/** A labelled input. The label focuses it, and the hint describes it to a screen reader. */
export function TextField({ label, hint, className, ...props }: TextFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} className={className}>
      <Input id={id} aria-describedby={hint === undefined ? undefined : `${id}-hint`} {...props} />
    </FieldFrame>
  );
}

interface TextAreaFieldProps extends ComponentProps<"textarea"> {
  readonly label: string;
  readonly hint?: ReactNode;
}

export function TextAreaField({ label, hint, className, ...props }: TextAreaFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint} className={className}>
      <Textarea
        id={id}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        {...props}
      />
    </FieldFrame>
  );
}

interface FormProblemProps {
  readonly children: string | null;
}

/** The reason a form was refused, next to the fields it is about. */
export function FormProblem({ children }: FormProblemProps) {
  if (children === null) return null;
  return (
    <p role="alert" className="text-sm text-pretty text-destructive">
      {children}
    </p>
  );
}
