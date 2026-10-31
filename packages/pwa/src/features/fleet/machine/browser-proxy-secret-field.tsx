import { MIN_SECRET_VALUE_LENGTH } from '@ferretry/protocol';
import { useId, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { SetupNote } from '../setup/setup-ui.tsx';

/** What storing came to: the name it was filed under, or the one sentence that says why not. */
export type StoreOutcome =
  | { readonly kind: 'stored'; readonly name: string }
  | { readonly kind: 'refused'; readonly sentence: string };

export interface BrowserProxySecretFieldProps {
  /** `username` or `password`. */
  readonly what: string;
  /** The name the value will be filed under (the name box when it holds one, else the default). */
  readonly name: string;
  readonly machineName: string;
  readonly online: boolean;
  readonly store: (value: string) => Promise<StoreOutcome>;
  /** Called with the name once the value is stored, so the name box can show it. */
  readonly onStored: (name: string) => void;
}

/**
 * A write-only place to paste a credential: the value goes to the machine's secret store under a NAME and
 * is never read back, shown again, or kept here. The box is emptied the moment the machine has it.
 */
export function BrowserProxySecretField({
  what,
  name,
  machineName,
  online,
  store,
  onStored,
}: BrowserProxySecretFieldProps) {
  const id = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<StoreOutcome | null>(null);
  const tooShort = value !== '' && value.length < MIN_SECRET_VALUE_LENGTH;
  const submit = (): void => {
    if (value === '' || tooShort || busy) return;
    const sent = value;
    setBusy(true);
    setSaid(null);
    void store(sent).then(outcome => {
      setBusy(false);
      setSaid(outcome);
      if (outcome.kind === 'stored') {
        setValue('');
        onStored(outcome.name);
      }
    });
  };
  return (
    <div className="flex min-w-0 flex-col gap-1" data-browser-proxy-secret-field={what}>
      <label htmlFor={id} className="text-meta font-semibold text-fg">
        Paste the {what} to store it as {name}
      </label>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
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
          placeholder={`the ${what} — it is never shown again`}
          data-browser-proxy-secret-value={what}
          onChange={event => {
            setValue(event.target.value);
            setSaid(null);
          }}
        />
        <Button
          type="button"
          data-browser-proxy-secret-store={what}
          disabled={value === '' || tooShort || busy || !online}
          onClick={submit}
        >
          {busy ? 'Storing…' : `Store as ${name}`}
        </Button>
      </div>
      {tooShort ? (
        <p className="m-0 text-meta leading-base text-muted" data-browser-proxy-secret-short="">
          The secret store keeps values of at least {String(MIN_SECRET_VALUE_LENGTH)} characters: a shorter one cannot
          be hidden safely from output.
        </p>
      ) : null}
      {said === null ? null : said.kind === 'stored' ? (
        <SetupNote live tone="ok" name={`browser-proxy-secret-${what}`} title={`Stored as ${said.name}`}>
          <span>{machineName} keeps it; it is not shown again and this page no longer holds it.</span>
        </SetupNote>
      ) : (
        <SetupNote live tone="warn" name={`browser-proxy-secret-${what}`} title="Not stored">
          <span data-browser-proxy-secret-refusal="">{said.sentence}</span>
        </SetupNote>
      )}
    </div>
  );
}
