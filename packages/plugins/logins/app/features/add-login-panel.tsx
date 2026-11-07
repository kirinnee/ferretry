/**
 * Add a login — the provider presets an environment login can be made from, read from `GET /v1/logins/presets`.
 *
 * GAP(runtimes): creating the login is a reviewed change whose routes are Runtimes', which a Logins view cannot call, so
 * this panel lists what is on offer and says so. Signing a Claude Code or Codex login in is not affected: that is the
 * Sign-ins tab.
 */

import { useEffect, useState } from 'react';
import type { ProviderPresetCatalog } from '../../contract/index.ts';
import { LoginScopeChip } from '../components/login-scope-chip.tsx';
import { type LoginsClient, refusalSentence } from '../lib/client.ts';
import { readPresets } from '../lib/logins-api.ts';
import { HARNESS_NAMES, HARNESSES } from '../lib/logins-view.ts';

export const ADD_LOGIN_NOTE =
  'Adding a login from a preset is not available from this screen yet. Sign in to Claude Code or Codex from the Sign-ins tab.';

export function AddLoginPanel({ client }: { readonly client: LoginsClient }) {
  const [catalog, setCatalog] = useState<ProviderPresetCatalog | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    readPresets(client).then(
      read => {
        if (alive) setCatalog(read);
      },
      (error: unknown) => {
        if (alive) setFailure(refusalSentence(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [client]);

  return (
    <section className="flex min-w-0 flex-col gap-3" data-add-login="">
      <p className="m-0 text-cell leading-base text-muted" data-add-login-note="">
        {ADD_LOGIN_NOTE}
      </p>
      {failure === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-warn">
          {failure}
        </p>
      )}
      {catalog === null
        ? failure === null && (
            <p role="status" className="m-0 text-cell text-muted">
              Reading the providers…
            </p>
          )
        : HARNESSES.map(harness => {
            const presets = catalog.presets.filter(preset => preset.harness === harness);
            if (presets.length === 0) return null;
            return (
              <div key={harness} data-add-login-group={harness}>
                <h4 className="m-0 text-meta font-semibold uppercase text-muted">{HARNESS_NAMES[harness]}</h4>
                <ul className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                  {presets.map(preset => (
                    <li
                      key={preset.id}
                      className="kt-panel flex flex-col gap-1 p-panel"
                      data-add-login-preset={preset.id}
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="text-row font-semibold text-fg">{preset.label}</span>
                        <LoginScopeChip
                          harnesses={preset.halves.filter(half => half.offered.available).map(half => half.harness)}
                        />
                      </span>
                      <span className="text-cell leading-base text-muted">{preset.summary}</span>
                      {preset.offered.available ? null : (
                        <span className="text-meta text-warn">Not offered: {preset.offered.reason}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
    </section>
  );
}
