import type { BrowserProxySetting, FleetMachineView } from '@ferretry/protocol';
import { useId, useRef, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import type { SetupAccess } from '../setup/setup-access.ts';
import { SetupNote, SetupSection } from '../setup/setup-ui.tsx';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { testBrowserProxy } from './browser-proxy-api.ts';
import { type BrowserProxyDraft, draftOf, settingOf } from './browser-proxy-draft.ts';
import { BrowserProxyTestBlock } from './browser-proxy-test-block.tsx';
import type { ProxyTestShown } from './browser-proxy-test-result.tsx';
import { machineSettings } from './machine-settings.ts';

/**
 * "Browser proxy" (docs/browser-proxy.md): where the agent browser sends its traffic. Empty means direct.
 * The form holds the NAMES of secrets, never a username or password: those live in the secret store
 * (`fy secret set NAME`) and the browser reads them when it starts.
 *
 * "Test proxy" asks the daemon to try one request through the proxy: the one being edited when it differs
 * from the saved one, else the saved one. The daemon resolves the secrets; nothing is saved by a test.
 */
export function BrowserProxySection({
  machine,
  machineName,
  access,
  onSaved,
  online = true,
}: {
  readonly machine: FleetMachineView;
  readonly machineName: string;
  readonly access: SetupAccess;
  readonly onSaved: () => void;
  /** `false` while the machine does not answer: a test could not run. */
  readonly online?: boolean;
}) {
  const { changes } = access;
  const ids = useId();
  const saved = machine.browserProxy ?? null;
  const [draft, setDraft] = useState<BrowserProxyDraft>(draftOf(saved));
  const [testing, setTesting] = useState(false);
  const [shown, setShown] = useState<ProxyTestShown | null>(null);
  const testRun = useRef(0);
  // Whatever a test said is about the proxy as it was: an edit makes it stale, and an answer still on its
  // way for the old text is dropped.
  const forgetTest = (): void => {
    testRun.current += 1;
    setTesting(false);
    setShown(null);
  };
  const edit = (patch: Partial<BrowserProxyDraft>): void => {
    setDraft(current => ({ ...current, ...patch }));
    changes.clear();
    forgetTest();
  };
  // A daemon that predates the setting cannot be asked for it.
  if (machine.browserProxy === undefined) return null;

  const wanted = draft.url.trim() === '' ? ({ ok: true, setting: null } as const) : settingOf(draft);
  const before = JSON.stringify(draftOf(saved));
  const dirty = JSON.stringify(draft) !== before;
  // What to test: nothing is sent for the saved proxy (`{}`); the edited setting is sent only when it differs.
  const testBody: { readonly proxy?: BrowserProxySetting } | null =
    draft.url.trim() === ''
      ? saved === null
        ? null
        : {}
      : wanted.ok && wanted.setting !== null
        ? dirty
          ? { proxy: wanted.setting }
          : {}
        : null;
  const typed = draft.url.trim() !== '';
  const test = (): void => {
    if (typed && !wanted.ok) {
      testRun.current += 1;
      setTesting(false);
      setShown({ kind: 'refused', sentence: wanted.problem });
      return;
    }
    if (testBody === null) return;
    testRun.current += 1;
    const mine = testRun.current;
    setTesting(true);
    setShown(null);
    void access
      .act(client => testBrowserProxy(client, testBody.proxy))
      .then(outcome => {
        if (testRun.current !== mine) return;
        setTesting(false);
        setShown(
          outcome.kind === 'done'
            ? { kind: 'result', result: outcome.value }
            : { kind: 'refused', sentence: outcome.sentence },
        );
      });
  };
  const apply = (browserProxy: NonNullable<typeof saved> | null): void => {
    void changes.apply(machineSettings(machine, { browserProxy })).then(result => {
      if (result.kind === 'refused') return;
      onSaved();
    });
  };

  const testHint =
    !typed && saved === null
      ? 'Type a proxy address to test it.'
      : `Tries one request through the proxy from ${machineName}, using the stored secrets. ${dirty && typed ? 'It tests what is typed above, saved or not. ' : ''}Nothing is saved.`;

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
      <BrowserProxyTestBlock
        disabled={(testBody === null && !(typed && !wanted.ok)) || !online}
        testing={testing}
        hint={testHint}
        shown={shown}
        onTest={test}
      />
      {wanted.ok && dirty ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel={wanted.setting === null ? 'Turn the browser proxy off' : 'Save browser proxy'}
          onSubmit={() => apply(wanted.setting)}
        >
          <Button
            type="button"
            data-browser-proxy-undo=""
            onClick={() => {
              setDraft(draftOf(saved));
              forgetTest();
            }}
          >
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
