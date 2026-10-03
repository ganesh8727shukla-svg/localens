import { forwardRef, useId } from "react";
import type {
  InputHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  errorMessage?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, hint, errorMessage, id, ...props }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const hintId = hint ? `${inputId}-hint` : undefined;
    const errorId = errorMessage ? `${inputId}-error` : undefined;

    return (
      <div className="flex flex-col gap-1.5">
        {label ? (
          <label htmlFor={inputId} className="text-sm font-medium text-ink">
            {label}
          </label>
        ) : null}

        <input
          ref={ref}
          id={inputId}
          aria-describedby={cn(hintId, errorId) || undefined}
          aria-invalid={Boolean(errorMessage) || undefined}
          className={cn(
            "h-11 w-full rounded-[1rem] border border-line-strong bg-surface-raised px-4 text-sm text-ink placeholder:text-ink-subtle",
            "transition-[border-color,box-shadow,background-color] duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            "disabled:cursor-not-allowed disabled:opacity-60",
            errorMessage && "border-danger",
            className,
          )}
          {...props}
        />

        {hint && !errorMessage ? (
          <p id={hintId} className="text-xs text-ink-subtle">
            {hint}
          </p>
        ) : null}

        {errorMessage ? (
          <p id={errorId} role="alert" className="text-xs text-danger">
            {errorMessage}
          </p>
        ) : null}
      </div>
    );
  },
);

Input.displayName = "Input";

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, id, ...props }, ref) => {
    const autoId = useId();
    const areaId = id ?? autoId;

    return (
      <div className="flex flex-col gap-1.5">
        {label ? (
          <label htmlFor={areaId} className="text-sm font-medium text-ink">
            {label}
          </label>
        ) : null}

        <textarea
          ref={ref}
          id={areaId}
          className={cn(
            "min-h-24 w-full rounded-[1rem] border border-line-strong bg-surface-raised px-4 py-3 text-sm text-ink placeholder:text-ink-subtle",
            "transition-[border-color,box-shadow,background-color] duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            "disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}
          {...props}
        />
      </div>
    );
  },
);

Textarea.displayName = "Textarea";
