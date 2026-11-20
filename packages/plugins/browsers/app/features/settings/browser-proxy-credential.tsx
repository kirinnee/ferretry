import { useId, useState } from 'react';
import { Button, SecretInput, type SecretField } from '@ferretry/app/ui';

/** What a stored credential shows instead of its value: a constant, so not even the length is given away. */
const MASK = '••••••••••••';

export interface BrowserProxyCredentialProps {
  /** `Username` or `Password`. */
  readonly what: 'Username' | 'Password';
  /** Whether a secret is already filed for this credential. */
  readonly stored: boolean;
  /**
   * What has been typed and not yet saved. The form owns the field (`useSecretField`) so it can read the value to file it;
   * the characters live only in the input node, never in any component's state or in the input's `value` attribute.
   */
  readonly field: SecretField;
  /** Told after what is typed changes or is emptied, so the form can drop a stale problem and test result. */
  readonly onChanged: () => void;
  readonly onRemove: () => void;
  /** One short sentence when saving this value failed. */
  readonly problem: string | null;
}

/**
 * One write-only credential. Stored, it reads as a filled box (masked, never the value) with Replace and
 * Remove; otherwise it is an empty box that the form's Save files in the machine's secret store.
 */
export function BrowserProxyCredential({
  what,
  stored,
  field,
  onChanged,
  onRemove,
  problem,
}: BrowserProxyCredentialProps) {
  const id = useId();
  const key = what.toLowerCase();
  const [replacing, setReplacing] = useState(false);
  const showBox = !stored || replacing;
  return (
    <div className="flex min-w-0 max-w-[28rem] flex-col gap-1" data-browser-proxy-credential={key}>
      <label htmlFor={id} className="text-ui font-semibold text-fg">
        {what}
      </label>
      {showBox ? (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <SecretInput
            id={id}
            field={field}
            className="kt-input min-w-0 flex-1"
            placeholder={replacing ? `New ${key}` : ''}
            data-browser-proxy-credential-value={key}
            onTyped={onChanged}
          />
          {replacing ? (
            <Button
              type="button"
              data-browser-proxy-credential-cancel={key}
              onClick={() => {
                setReplacing(false);
                field.clear();
                onChanged();
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <input
            id={id}
            readOnly
            tabIndex={-1}
            className="kt-input min-w-0 flex-1 text-muted"
            value={MASK}
            aria-label={`${what}: stored`}
            data-browser-proxy-credential-stored={key}
          />
          <div className="flex gap-2">
            <Button type="button" data-browser-proxy-credential-replace={key} onClick={() => setReplacing(true)}>
              Replace
            </Button>
            <Button type="button" data-browser-proxy-credential-remove={key} onClick={onRemove}>
              Remove
            </Button>
          </div>
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
