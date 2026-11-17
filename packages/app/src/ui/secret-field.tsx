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
 *
 * A pasted BLOCK (several keys, a callback address carrying an authorization code, a pairing link) is the same
 * contract on a `<textarea>`: a controlled textarea serialises its value as its text content, so
 * {@link useSecretTextarea} / {@link SecretTextarea} keep it uncontrolled too. Neither takes a `name` or a `form`: a
 * named field in a form that submitted natively would put the value in a URL.
 */
import {
  type ChangeEvent,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

/** What every secret field gives, whatever it is drawn with: how much is typed, and the only way to read it. */
interface SecretFieldState {
  /** How many characters are typed (as {@link SecretMeasure} counts them). The only thing about the value React state holds. */
  readonly length: number;
  /** Whether anything is typed. */
  readonly filled: boolean;
  /** Bumps on every change, so a render that derives something from {@link read} re-runs when the text changes. */
  readonly revision: number;
  /** The typed value, read from the node now. Empty when there is no field on screen. Never put it in state. */
  readonly read: () => string;
  /** Empties the node itself and forgets how much was typed. */
  readonly clear: () => void;
  /** Counts a typed value the way {@link length} does. */
  readonly measure: SecretMeasure;
}

/** The attributes that keep a password manager, spell-checker and autofill from filing a copy. */
interface SecretOptOuts {
  readonly autoCapitalize: 'off';
  readonly autoCorrect: 'off';
  readonly spellCheck: false;
  readonly 'data-1p-ignore': '';
  readonly 'data-lpignore': 'true';
  readonly 'data-bwignore': '';
}

/** What {@link useSecretField} gives: the props for the input, how much is typed, and the only way to read it. */
export interface SecretField extends SecretFieldState {
  /** Spread on the `<input>`; {@link SecretInput} does it for you. */
  readonly inputProps: SecretOptOuts & {
    readonly ref: (node: HTMLInputElement | null) => void;
    readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    readonly type: 'password';
    readonly autoComplete: 'new-password';
  };
}

/** What {@link useSecretTextarea} gives: {@link SecretField}'s contract for a `<textarea>`. */
export interface SecretTextareaField extends SecretFieldState {
  /** Spread on the `<textarea>`; {@link SecretTextarea} does it for you. */
  readonly inputProps: SecretOptOuts & {
    readonly ref: (node: HTMLTextAreaElement | null) => void;
    readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
    readonly autoComplete: 'off';
  };
}

/** Counts a typed value; trims first for a field that ignores surrounding spaces. */
export type SecretMeasure = (typed: string) => number;

const plainLength: SecretMeasure = typed => typed.length;

/** What a secret node is: an input or a textarea, both of which hold their text in `value`. */
type SecretNode = HTMLInputElement | HTMLTextAreaElement;

const OPT_OUTS: SecretOptOuts = {
  autoCapitalize: 'off',
  autoCorrect: 'off',
  spellCheck: false,
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
};

/** The one implementation behind both hooks: the node, how much is typed, and when it is emptied. */
function useSecretNode<Node extends SecretNode>(measure: SecretMeasure) {
  const node = useRef<Node | null>(null);
  const measured = useRef(measure);
  measured.current = measure;
  const [length, setLength] = useState(0);
  const [revision, setRevision] = useState(0);

  const attach = useCallback((next: Node | null): void => {
    if (next === null) {
      // The field is leaving the screen: empty it before React lets go, and forget how much was in it.
      if (node.current !== null) node.current.value = '';
      node.current = null;
      setLength(0);
    } else {
      node.current = next;
      setLength(measured.current(next.value));
    }
    setRevision(count => count + 1);
  }, []);

  const onChange = useCallback((event: ChangeEvent<Node>): void => {
    setLength(measured.current(event.currentTarget.value));
    setRevision(count => count + 1);
  }, []);

  const read = useCallback((): string => node.current?.value ?? '', []);
  const count = useCallback<SecretMeasure>(typed => measured.current(typed), []);

  const clear = useCallback((): void => {
    if (node.current !== null) node.current.value = '';
    setLength(0);
    setRevision(next => next + 1);
  }, []);

  // A page sent to the background drops what was typed: nobody is watching it.
  useEffect(() => {
    const hide = (): void => {
      if (document.visibilityState === 'hidden') clear();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [clear]);

  return { attach, onChange, length, filled: length > 0, revision, read, clear, measure: count };
}

/**
 * One secret field's state: see the file comment. `measure` decides what "how much is typed" counts (a field that
 * ignores surrounding spaces passes `typed => typed.trim().length`).
 */
export function useSecretField(measure: SecretMeasure = plainLength): SecretField {
  const { attach, onChange, ...state } = useSecretNode<HTMLInputElement>(measure);
  return {
    ...state,
    inputProps: { ...OPT_OUTS, ref: attach, onChange, type: 'password', autoComplete: 'new-password' },
  };
}

/** {@link useSecretField} for a `<textarea>`: a pasted block that must not become the textarea's text content. */
export function useSecretTextarea(measure: SecretMeasure = plainLength): SecretTextareaField {
  const { attach, onChange, ...state } = useSecretNode<HTMLTextAreaElement>(measure);
  return { ...state, inputProps: { ...OPT_OUTS, ref: attach, onChange, autoComplete: 'off' } };
}

/** What a caller may still set on the input: everything except what would make it controlled, readable or submitted. */
export type SecretInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'type' | 'ref' | 'onChange' | 'children' | 'dangerouslySetInnerHTML' | 'name' | 'form'
> & {
  readonly field: SecretField;
  /** Told after each change, with the new length only (counted the way the field's measure counts). */
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
        onTyped?.(field.measure(event.currentTarget.value));
      }}
    />
  );
}

/** What a caller may still set on the textarea: the same exclusions as {@link SecretInputProps}. */
export type SecretTextareaProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'defaultValue' | 'ref' | 'onChange' | 'children' | 'dangerouslySetInnerHTML' | 'name' | 'form'
> & {
  readonly field: SecretTextareaField;
  /** Told after each change, with the new length only (counted the way the field's measure counts). */
  readonly onTyped?: (length: number) => void;
};

/** The secret `<textarea>` itself. Never given a `value` or children: see the file comment. */
export function SecretTextarea({ field, onTyped, ...rest }: SecretTextareaProps) {
  const { onChange, ...props } = field.inputProps;
  return (
    <textarea
      {...rest}
      {...props}
      onChange={event => {
        onChange(event);
        onTyped?.(field.measure(event.currentTarget.value));
      }}
    />
  );
}
