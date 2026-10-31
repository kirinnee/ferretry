import { MIN_SECRET_VALUE_LENGTH } from '@ferretry/protocol';
import { useId, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';

/** What storing came to: the name it was filed under, or the one sentence that says why not. */
export type StoreOutcome =
  | { readonly kind: 'stored'; readonly name: string }
  | { readonly kind: 'refused'; readonly sentence: string };

export interface BrowserProxyCredentialProps {
  /** `Username` or `Password`. */
  readonly what: 'Username' | 'Password';
  /** Whether a secret is already filed for this credential. */
  readonly stored: boolean;
  readonly online: boolean;
  readonly store: (value: string) => Promise<StoreOutcome>;
  /** Called with the name once the value is stored, so the setting can point at it. */
  readonly onStored: (name: string) => void;
  readonly onRemove: () => void;
}

/**
 * One write-only credential: an empty box that files what is typed in the machine's secret store, or, once
 * something is stored, "Stored · Replace · Remove". The value is never read back, shown or kept here: the
 * box is emptied the moment the machine has it.
 */
export function BrowserProxyCredential({
  what,
  stored,
  online,
  store,
  onStored,
  onRemove,
}: BrowserProxyCredentialProps) {
  const id = useId();
  const key = what.toLowerCase();
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const showBox = !stored || replacing;
  const submit = (): void => {
    if (value === '' || busy) return;
    if (value.length < MIN_SECRET_VALUE_LENGTH) {
      setProblem(`Use at least ${String(MIN_SECRET_VALUE_LENGTH)} characters.`);
      return;
    }
    setBusy(true);
    setProblem(null);
    void store(value).then(outcome => {
      setBusy(false);
      if (outcome.kind === 'refused') {
        setProblem(outcome.sentence);
        return;
      }
      setValue('');
      setReplacing(false);
      onStored(outcome.name);
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-1" data-browser-proxy-credential={key}>
      <label htmlFor={id} className="text-ui font-semibold text-fg">
        {what}
      </label>
      {showBox ? (
        <form
          className="flex min-w-0 flex-col gap-2 sm:flex-row"
          onSubmit={event => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            id={id}
            // `password` hides it from a shoulder; `new-password` keeps a password manager from filing a copy.
            type="password"
            autoComplete="new-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="kt-input min-w-0 flex-1"
            value={value}
            data-browser-proxy-credential-value={key}
            onChange={event => {
              setValue(event.target.value);
              setProblem(null);
            }}
          />
          <div className="flex gap-2">
            <Button type="submit" data-browser-proxy-credential-save={key} disabled={value === '' || busy || !online}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            {replacing ? (
              <Button
                type="button"
                data-browser-proxy-credential-cancel={key}
                onClick={() => {
                  setReplacing(false);
                  setValue('');
                  setProblem(null);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2" id={id}>
          <span className="text-ui text-ok" data-browser-proxy-credential-stored={key}>
            Stored
          </span>
          <Button type="button" data-browser-proxy-credential-replace={key} onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button type="button" data-browser-proxy-credential-remove={key} onClick={onRemove}>
            Remove
          </Button>
        </div>
      )}
      {problem === null ? null : (
        <p role="alert" className="m-0 text-meta leading-base text-err" data-browser-proxy-credential-problem={key}>
          {problem}
        </p>
      )}
    </div>
  );
}
