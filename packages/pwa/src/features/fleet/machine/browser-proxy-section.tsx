import type { FleetMachineView } from '@ferretry/protocol';
import { useId, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import { type SetupAccess } from '../setup/setup-access.ts';
import { SetupNote, SetupSection } from '../setup/setup-ui.tsx';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { type BrowserProxyDraft, draftOf, settingOf } from './browser-proxy-draft.ts';
import { machineSettings } from './machine-settings.ts';

/**
 * "Browser proxy" (docs/browser-proxy.md): where the agent browser sends its traffic. Empty means direct.
 * The form holds the NAMES of secrets, never a username or password: those live in the secret store
 * (`fy secret set NAME`) and the browser reads them when it starts.
 */
export function BrowserProxySection({
  machine,
  machineName,
  access,
  onSaved,
}: {
  readonly machine: FleetMachineView;
  readonly machineName: string;
  readonly access: SetupAccess;
  readonly onSaved: () => void;
}) {
  const { changes } = access;
  const ids = useId();
  const saved = machine.browserProxy ?? null;
  const [draft, setDraft] = useState<BrowserProxyDraft>(draftOf(saved));
  const edit = (patch: Partial<BrowserProxyDraft>): void => {
    setDraft(current => ({ ...current, ...patch }));
    changes.clear();
  };
  // A daemon that predates the setting cannot be asked for it.
  if (machine.browserProxy === undefined) return null;

  const wanted = draft.url.trim() === '' ? ({ ok: true, setting: null } as const) : settingOf(draft);
  const before = JSON.stringify(draftOf(saved));
  const dirty = JSON.stringify(draft) !== before;
  const apply = (browserProxy: NonNullable<typeof saved> | null): void => {
    void changes.apply(machineSettings(machine, { browserProxy })).then(result => {
      if (result.kind === 'refused') return;
      onSaved();
    });
  };

  return (
    <SetupSection title="Browser proxy" name="browser-proxy">
      <p className="m-0 text-meta leading-base text-muted">
        Send the shared browser's traffic through a proxy. Leave the address empty to go direct. The window you sign in
        through is not proxied.
      </p>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${ids}-url`} className="text-ui font-semibold text-fg">
          Proxy address
        </label>
        <input
          id={`${ids}-url`}
          className="kt-input min-w-0 font-mono"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="http://proxy.example:8080 or socks5://proxy.example:1080"
          value={draft.url}
          data-browser-proxy-url=""
          onChange={event => edit({ url: event.target.value })}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${ids}-bypass`} className="text-ui font-semibold text-fg">
          Skip the proxy for (optional)
        </label>
        <textarea
          id={`${ids}-bypass`}
          className="kt-input min-h-16 min-w-0 font-mono"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={'*.internal.example\n10.0.0.0/8'}
          value={draft.bypass}
          data-browser-proxy-bypass=""
          onChange={event => edit({ bypass: event.target.value })}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${ids}-username`} className="text-ui font-semibold text-fg">
          Username secret (optional)
        </label>
        <input
          id={`${ids}-username`}
          className="kt-input min-w-0 font-mono"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="PROXY_USER"
          value={draft.usernameSecret}
          data-browser-proxy-username=""
          onChange={event => edit({ usernameSecret: event.target.value })}
        />
        <label htmlFor={`${ids}-password`} className="text-ui font-semibold text-fg">
          Password secret (optional)
        </label>
        <input
          id={`${ids}-password`}
          className="kt-input min-w-0 font-mono"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          placeholder="PROXY_PASSWORD"
          value={draft.passwordSecret}
          data-browser-proxy-password=""
          onChange={event => edit({ passwordSecret: event.target.value })}
        />
        <p className="m-0 text-meta leading-base text-muted">
          Name the secrets, never type the value. Store each on {machineName} with <code>fy secret set NAME</code>.
        </p>
      </div>
      {wanted.ok ? null : (
        <SetupNote tone="warn" name="browser-proxy-problem" live>
          {wanted.problem}
        </SetupNote>
      )}
      {wanted.ok && dirty ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel={wanted.setting === null ? 'Turn the browser proxy off' : 'Save browser proxy'}
          onSubmit={() => apply(wanted.setting)}
        >
          <Button type="button" data-browser-proxy-undo="" onClick={() => setDraft(draftOf(saved))}>
            Keep what is saved
          </Button>
        </ChangeApplyPanel>
      ) : null}
      <p className="m-0 text-meta leading-base text-muted" data-browser-proxy-hint="">
        Applies the next time the browser on {machineName} starts.
      </p>
    </SetupSection>
  );
}
