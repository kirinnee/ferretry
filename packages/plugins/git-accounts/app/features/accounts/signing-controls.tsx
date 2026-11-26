import { useState } from 'react';
import { isGpgKey, type GitAccount, type GitKeyFormat } from '../../../contract/index.ts';
import { createSigningKey, removeSigningKey } from '../../lib/accounts-api.ts';
import { explainFailure } from '../../lib/connect-state.ts';
import type { GitAccountsClient } from '../../shell.tsx';
import { SigningChoice } from '../connect/signing-choice.tsx';

export function SigningControls({
  account,
  client,
  onChanged,
}: {
  readonly account: GitAccount;
  readonly client: GitAccountsClient;
  readonly onChanged: () => void;
}) {
  const [format, setFormat] = useState<GitKeyFormat>('ssh');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const needsGpg = format === 'gpg' && !account.scopes.includes('admin:gpg_key');
  const held = account.keys.signing;
  const change = async (remove: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      if (remove) await removeSigningKey(client, account.id);
      else await createSigningKey(client, account.id, format);
      setAsking(false);
      onChanged();
    } catch (cause) {
      setFailure(explainFailure(cause));
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col items-start gap-2" aria-label={`Signing for @${account.login}`}>
      {held === undefined ? (
        <>
          <SigningChoice name={`signing-${account.id}`} value={format} onChange={setFormat} disabled={busy} />
          {needsGpg ? (
            <p className="m-0 text-cell leading-base text-muted">
              Connect @{account.login} again below and choose GPG to allow adding and removing its signing key.
            </p>
          ) : null}
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            disabled={busy || needsGpg}
            onClick={() => void change(false)}
          >
            Create {format === 'gpg' ? 'GPG' : 'SSH'} signing key
          </button>
        </>
      ) : (
        <>
          <p className="m-0 text-cell text-muted">
            {held.revoking === true
              ? 'Signing stopped. Key cleanup is pending.'
              : `Signing with ${isGpgKey(held) ? 'GPG' : 'SSH'}.`}
          </p>
          {asking ? (
            <>
              <p className="m-0 text-cell leading-base text-muted">
                Stop using this signing key and remove its registration from GitHub? You can then choose another format.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="kt-btn min-h-[44px]"
                  data-variant="danger"
                  disabled={busy}
                  onClick={() => void change(true)}
                >
                  Remove signing key
                </button>
                <button type="button" className="kt-btn min-h-[44px]" disabled={busy} onClick={() => setAsking(false)}>
                  Keep signing key
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="kt-btn min-h-[44px]" disabled={busy} onClick={() => setAsking(true)}>
              Change signing key
            </button>
          )}
        </>
      )}
      {held?.revoking === true && held.openpgpFingerprint !== undefined ? (
        <p className="m-0 mono break-all text-meta text-muted">Fingerprint: {held.openpgpFingerprint}</p>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="m-0 text-cell text-err">
          {failure}
        </p>
      )}
    </section>
  );
}
