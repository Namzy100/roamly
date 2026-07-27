import { AlertCircle } from "lucide-react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * One labelled form row.
 *
 * Wiring `htmlFor`/`id`, the hint, and the error message together in one place
 * means every field in the builder is described correctly without each caller
 * having to remember `aria-describedby`.
 */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </Label>
      {hint ? (
        <p id={hintId} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      {children}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

/**
 * Grouped controls (chips, radio cards) need a fieldset and legend rather than
 * a label pointing at a single input.
 */
export function FieldSet({
  legend,
  hint,
  error,
  className,
  children,
}: {
  legend: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const id = legend.toLowerCase().replace(/[^a-z]+/g, "-");

  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-2", className)}>
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      <div className="mt-1">{children}</div>
      <FieldError id={`${id}-error`} message={error} />
    </fieldset>
  );
}

/**
 * Errors are announced politely rather than assertively — validation fires on
 * blur and submit, so an assertive live region would interrupt the user mid-form.
 */
export function FieldError({
  id,
  message,
}: {
  id?: string;
  message?: string;
}) {
  return (
    <p
      id={id}
      role={message ? "alert" : undefined}
      aria-live="polite"
      className={cn(
        "flex items-start gap-1.5 text-xs text-destructive transition-opacity",
        message ? "opacity-100" : "sr-only opacity-0",
      )}
    >
      {message ? (
        <>
          <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{message}</span>
        </>
      ) : null}
    </p>
  );
}
