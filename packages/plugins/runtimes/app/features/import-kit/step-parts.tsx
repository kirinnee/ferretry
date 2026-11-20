/**
 * The pieces a harness segment's first-run pages are drawn from, so Claude Code's page and Codex's page for the same
 * question look and behave as one: the page body, a line of words, the actions row, the command block, the runtime-name
 * field, and the two small terminal demos (an install check; an agent that asks before it runs a command, or does not).
 * Public through `@ferretry/plugin-runtimes/import-kit`. A page brings its own words; this draws the frame around them.
 */
import type { CSSProperties, ReactNode } from 'react';
import './step-parts.css';

/** The words every import page says about the Next button before the import has run. */
export const NEXT_LEAVES =
  'Next leaves the import for later. You can import any time from Settings › Runtimes › Import.';

/** The page body: a column of lines, cards and actions. `step` names the page for tests and the gate (`data-onboarding-step`). */
export function StepBody({
  step,
  label,
  children,
  ...data
}: {
  readonly step: string;
  /** The region's accessible name. */
  readonly label?: string;
  readonly children: ReactNode;
  readonly [key: `data-${string}`]: string | undefined;
}) {
  return (
    <section
      className="ob-step"
      data-onboarding-step={step}
      {...(label === undefined ? {} : { 'aria-label': label })}
      {...data}
    >
      {children}
    </section>
  );
}

/** One line of the page's words. */
export function StepLine({
  children,
  role,
  ...data
}: {
  readonly children: ReactNode;
  readonly role?: 'alert' | 'note' | 'status';
  readonly [key: `data-${string}`]: string | undefined;
}) {
  return (
    <p className="ob-step__line" {...(role === undefined ? {} : { role })} {...data}>
      {children}
    </p>
  );
}

/** A row of buttons: auto width, 44px tall. */
export function StepActions({ children }: { readonly children: ReactNode }) {
  return <div className="ob-actions">{children}</div>;
}

/** What a pick means, and the explicit presses that write it or keep what is saved. */
export function StepConfirm({
  children,
  ...data
}: {
  readonly children: ReactNode;
  readonly [key: `data-${string}`]: string | undefined;
}) {
  return (
    <div className="ob-confirm" {...data}>
      {children}
    </div>
  );
}

/** A command the person may run, shown whole. */
export function StepCommand({ children }: { readonly children: string }) {
  return (
    <pre className="ob-command" data-install-command="">
      {children}
    </pre>
  );
}

/** The runtime-name field of the import page. */
export function RuntimeNameField({
  value,
  invalid,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly invalid: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: string) => void;
}) {
  return (
    <label className="ob-field">
      Runtime name
      <input
        type="text"
        className="ob-input"
        value={value}
        maxLength={200}
        disabled={disabled === true}
        aria-invalid={invalid}
        data-runtime-name=""
        onChange={event => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

const typed = (command: string): CSSProperties =>
  ({ '--ob-chars': String(command.length), '--ob-width': `${String(command.length)}ch` }) as CSSProperties;

/** A terminal typing `<command>`, then the answer. */
export function InstalledDemo({
  command,
  answer,
  label,
}: {
  readonly command: string;
  readonly answer: string;
  readonly label: string;
}) {
  return (
    <div
      className="ob-demo"
      role="img"
      aria-label={`A terminal: ${command} answers with a version number`}
      data-demo="installed"
      data-demo-tool={label}
    >
      <p className="ob-demo__line">
        <span aria-hidden="true">$ </span>
        <span className="ob-type" style={typed(command)}>
          {command}
        </span>
      </p>
      <p className="ob-demo__line ob-fade">{answer}</p>
    </div>
  );
}

/** An agent that asks before running a command, against one that runs it straight through. */
export function PermissionDemo({ tool, mode }: { readonly tool: string; readonly mode: 'auto' | 'skip' }) {
  return (
    <div
      className="ob-demo"
      role="img"
      aria-label={
        mode === 'auto'
          ? `${tool} asks before it runs a command`
          : `${tool} runs the command straight through, without asking`
      }
      data-demo={`permission-${mode}`}
      data-demo-tool={tool}
      key={mode}
    >
      <p className="ob-demo__line">› rm -rf build/</p>
      {mode === 'auto' ? (
        <p className="ob-demo__line ob-ask">Run this command? [y/N]</p>
      ) : (
        <p className="ob-demo__line ob-run">✓ ran, without asking</p>
      )}
    </div>
  );
}
