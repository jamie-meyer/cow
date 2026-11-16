// The status line's prompts: one line of text, or a yes-or-no confirmation.

import { type ReactNode, type RefObject } from "react";

/** A one-line text prompt. Enter submits, Escape cancels; every other key types. */
export function TextPrompt({
  mode,
  name,
  label,
  placeholder,
  value,
  error,
  go,
  busy,
  inputRef,
  onChange,
  onSubmit,
  onCancel,
}: {
  mode: string;
  /** Marks the input so tests and focus handling can find it. */
  name: string;
  label: ReactNode;
  placeholder: string;
  value: string;
  error?: string;
  /** What Enter does, in a word. */
  go: string;
  busy?: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <span className="cow-mode cow-m-prompt">{mode}</span>
      <span className="cow-prompt">
        <label htmlFor={`cow-${name}`}>{label}</label>
        <input
          id={`cow-${name}`}
          ref={inputRef}
          data-cow-input={name}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Enter") onSubmit();
            else onCancel();
          }}
        />
        {error ? (
          <small className="cow-err" data-cow-prompt-error="">
            {error}
          </small>
        ) : (
          <small>
            <kbd>⏎</kbd> {go} · <kbd>Esc</kbd> cancel
          </small>
        )}
      </span>
    </>
  );
}

/** A question answered with `y`; any other key cancels. */
export function ConfirmPrompt({ mode, name, label }: { mode: string; name: string; label: string }) {
  return (
    <>
      <span className="cow-mode cow-m-prompt">{mode}</span>
      <span className="cow-noun">{name}</span>
      <span className="cow-sep">▸</span>
      <span className="cow-prompt" data-cow-confirm="">
        <label>{label}</label>
        <small>
          <kbd>y</kbd> yes · any other key cancels
        </small>
      </span>
    </>
  );
}
