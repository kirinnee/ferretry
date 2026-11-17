/**
 * The ONE secret input every password / key / seed field in the app draws with.
 *
 * A CONTROLLED password input (`value={state}`) makes React copy the typed secret into the input's `value` content
 * attribute, where `outerHTML`, a DOM snapshot, a browser extension or an agent's page read can see it. So the field is
 * UNCONTROLLED: the characters live only in the input node's own live value, are read through {@link SecretField.read}
 * at the moment of use, and React state holds only HOW MANY are typed (and a counter that says it changed) — enough to
 * enable a Save button or say "too short", never what it says.
 *
 * The field is emptied by {@link SecretField.clear} (a caller calls it the moment a value is sent, not when the answer
 * comes back), when the page is hidden, and when the input leaves the screen (its node is emptied as React lets go of it).
 * `autoComplete="new-password"` and the password-manager opt-outs keep a manager from filing a copy.
 */
import { type ChangeEvent, type InputHTMLAttributes, useCallback, useEffect, useRef, useState } from 'react';

/** What {@link useSecretField} gives: the props for the input, how much is typed, and the only way to read it. */
export interface SecretField {
  /** Spread on the `<input>`; {@link SecretInput} does it for you. */
  readonly inputProps: {
    readonly ref: (node: HTMLInputElement | null) => void;
    readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    readonly type: 'password';
    readonly autoComplete: 'new-password';
    readonly autoCapitalize: 'off';
    readonly autoCorrect: 'off';
    readonly spellCheck: false;
    readonly 'data-1p-ignore': '';
    readonly 'data-lpignore': 'true';
    readonly 'data-bwignore': '';
  };
  /** How many characters are typed. The only thing about the value React state holds. */
  readonly length: number;
  /** Whether anything is typed. */
  readonly filled: boolean;
  /** Bumps on every change, so a render that derives something from {@link read} re-runs when the text changes. */
  readonly revision: number;
  /** The typed value, read from the input node now. Empty when there is no input on screen. Never put it in state. */
  readonly read: () => string;
  /** Empties the input itself and forgets how much was typed. */
  readonly clear: () => void;
}

/** Counts a typed value; trims first for a field that ignores surrounding spaces. */
export type SecretMeasure = (typed: string) => number;

const plainLength: SecretMeasure = typed => typed.length;

/**
 * One secret field's state: see the file comment. `measure` decides what "how much is typed" counts (a field that
 * ignores surrounding spaces passes `typed => typed.trim().length`).
 */
export function useSecretField(measure: SecretMeasure = plainLength): SecretField {
  const node = useRef<HTMLInputElement | null>(null);
  const measured = useRef(measure);
  measured.current = measure;
  const [length, setLength] = useState(0);
  const [revision, setRevision] = useState(0);

  const attach = useCallback((next: HTMLInputElement | null): void => {
    if (next === null) {
      // The input is leaving the screen: empty it before React lets go, and forget how much was in it.
      if (node.current !== null) node.current.value = '';
      node.current = null;
      setLength(0);
    } else {
      node.current = next;
      setLength(measured.current(next.value));
    }
    setRevision(count => count + 1);
  }, []);

  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    setLength(measured.current(event.currentTarget.value));
    setRevision(count => count + 1);
  }, []);

  const read = useCallback((): string => node.current?.value ?? '', []);

  const clear = useCallback((): void => {
    if (node.current !== null) node.current.value = '';
    setLength(0);
    setRevision(count => count + 1);
  }, []);

  // A page sent to the background drops what was typed: nobody is watching it.
  useEffect(() => {
    const hide = (): void => {
      if (document.visibilityState === 'hidden') clear();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [clear]);

  return {
    inputProps: {
      ref: attach,
      onChange,
      type: 'password',
      autoComplete: 'new-password',
      autoCapitalize: 'off',
      autoCorrect: 'off',
      spellCheck: false,
      'data-1p-ignore': '',
      'data-lpignore': 'true',
      'data-bwignore': '',
    },
    length,
    filled: length > 0,
    revision,
    read,
    clear,
  };
}

/** What a caller may still set on the input: everything except what would make it controlled or readable. */
export type SecretInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'type' | 'ref' | 'onChange' | 'children' | 'dangerouslySetInnerHTML'
> & {
  readonly field: SecretField;
  /** Told after each change, with the new length only. */
  readonly onTyped?: (length: number) => void;
};

/** The secret `<input>` itself. Never given a `value`: see the file comment. */
export function SecretInput({ field, onTyped, ...rest }: SecretInputProps) {
  const { onChange, ...props } = field.inputProps;
  return (
    <input
      {...rest}
      {...props}
      onChange={event => {
        onChange(event);
        onTyped?.(event.currentTarget.value.length);
      }}
    />
  );
}
