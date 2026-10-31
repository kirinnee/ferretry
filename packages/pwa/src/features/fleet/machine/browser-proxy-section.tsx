import { type BrowserProxySetting, type FleetMachineView, MIN_SECRET_VALUE_LENGTH } from '@ferretry/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import type { SetupAccess } from '../setup/setup-access.ts';
import { SetupNote, SetupSection } from '../setup/setup-ui.tsx';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { listSecrets, putSecret } from '../../secrets/secrets-api.ts';
import { testBrowserProxy } from './browser-proxy-api.ts';
import { type BrowserProxyDraft, draftOf, isSecretName, nameTyped, settingOf } from './browser-proxy-draft.ts';
import { BrowserProxyCredential } from './browser-proxy-credential.tsx';
import { BrowserProxyTestBlock } from './browser-proxy-test-block.tsx';
import type { ProxyTestShown } from './browser-proxy-test-result.tsx';
import { machineSettings } from './machine-settings.ts';

/**
 * "Browser proxy" (docs/browser-proxy.md): where the agent browser sends its traffic. Empty means direct.
 * The form holds the NAMES of secrets, never a username or password: a typed credential goes straight to the
 * machine's secret store (write-only) and the browser reads it when it starts.
 *
 * "Test proxy" asks the daemon to try one request through the proxy: the one being edited when it differs
 * from the saved one, else the saved one. The daemon resolves the secrets; nothing is saved by a test.
 */
const DEFAULT_USER = 'PROXY_USER';
const DEFAULT_PASSWORD = 'PROXY_PASSWORD';

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
  const { changes, read } = access;
  const ids = useId();
  const saved = machine.browserProxy ?? null;
  const [draft, setDraft] = useState<BrowserProxyDraft>(draftOf(saved));
  const [testing, setTesting] = useState(false);
  const [shown, setShown] = useState<ProxyTestShown | null>(null);
  // What was typed into the write-only boxes and not yet filed in the secret store. In memory only; emptied the
  // moment the machine has it.
  const [pending, setPending] = useState({ username: '', password: '' });
  const [problems, setProblems] = useState<{ username: string | null; password: string | null }>({
    username: null,
    password: null,
  });
  const testRun = useRef(0);
  const [existing, setExisting] = useState<ReadonlySet<string> | null>(null);
  const [expert, setExpert] = useState(
    [draftOf(saved).usernameSecret, draftOf(saved).passwordSecret].some(
      name => name !== '' && name !== DEFAULT_USER && name !== DEFAULT_PASSWORD,
    ),
  );
  useEffect(() => {
    if (machine.browserProxy === undefined) return;
    let live = true;
    void read(client => listSecrets(client)).then(outcome => {
      if (live && outcome.kind === 'done' && outcome.value.health === 'ready')
        setExisting(new Set(outcome.value.secrets.map(secret => secret.name)));
    });
    return () => {
      live = false;
    };
  }, [read, machine.browserProxy]);
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

  const nameFor = (box: string, fallback: string): string => (isSecretName(nameTyped(box)) ? nameTyped(box) : fallback);
  // The form as it will be once what was typed has been filed: a typed value is filed under the name already in
  // the box, else under PROXY_USER / PROXY_PASSWORD.
  const filed: BrowserProxyDraft = {
    ...draft,
    usernameSecret: pending.username === '' ? draft.usernameSecret : nameFor(draft.usernameSecret, DEFAULT_USER),
    passwordSecret: pending.password === '' ? draft.passwordSecret : nameFor(draft.passwordSecret, DEFAULT_PASSWORD),
  };
  const typed = draft.url.trim() !== '';
  const wanted = typed ? settingOf(filed) : ({ ok: true, setting: null } as const);
  const before = JSON.stringify(draftOf(saved));
  const dirty = JSON.stringify(filed) !== before || pending.username !== '' || pending.password !== '';
  // What to test: nothing is sent for the saved proxy (`{}`); the edited setting is sent only when it differs.
  const testBody: { readonly proxy?: BrowserProxySetting } | null = !typed
    ? saved === null
      ? null
      : {}
    : wanted.ok && wanted.setting !== null
      ? dirty
        ? { proxy: wanted.setting }
        : {}
      : null;
  const runTest = async (body: { readonly proxy?: BrowserProxySetting }): Promise<void> => {
    testRun.current += 1;
    const mine = testRun.current;
    setTesting(true);
    setShown(null);
    const outcome = await access.act(client => testBrowserProxy(client, body.proxy));
    if (testRun.current !== mine) return;
    setTesting(false);
    setShown(
      outcome.kind === 'done'
        ? { kind: 'result', result: outcome.value }
        : { kind: 'refused', sentence: outcome.sentence },
    );
  };
  const refuseTest = (sentence: string): void => {
    testRun.current += 1;
    setTesting(false);
    setShown({ kind: 'refused', sentence });
  };
  // Files what was typed in the secret store. False (with one short sentence on the box) when it cannot be.
  const fileCredentials = async (): Promise<boolean> => {
    const boxes = [
      ['username', pending.username, filed.usernameSecret],
      ['password', pending.password, filed.passwordSecret],
    ] as const;
    const short = boxes.filter(([, value]) => value !== '' && value.length < MIN_SECRET_VALUE_LENGTH);
    if (short.length > 0) {
      setProblems(current => ({
        ...current,
        ...Object.fromEntries(
          short.map(([key]) => [key, `Use at least ${String(MIN_SECRET_VALUE_LENGTH)} characters.`]),
        ),
      }));
      return false;
    }
    for (const [key, value, name] of boxes) {
      if (value === '') continue;
      const outcome = await read(client => putSecret(client, name, value));
      if (outcome.kind !== 'done') {
        setProblems(current => ({ ...current, [key]: outcome.sentence }));
        return false;
      }
      setExisting(current => new Set([...(current ?? []), name]));
      setPending(current => ({ ...current, [key]: '' }));
      setDraft(current => ({ ...current, [`${key}Secret`]: name }));
    }
    return true;
  };
  const test = (): void => {
    if (typed && !wanted.ok) {
      refuseTest(wanted.problem);
      return;
    }
    if (testBody === null) return;
    void (async () => {
      if (!(await fileCredentials())) return;
      await runTest(testBody);
    })();
  };
  // Is something filed under this box's name? Until the list has been read, only what was saved is taken to be.
  const isStored = (box: string, savedName: string): boolean => {
    const name = nameTyped(box);
    return isSecretName(name) && (existing === null ? name === savedName : existing.has(name));
  };
  const savedNames = draftOf(saved);
  const typedInto = (key: 'username' | 'password', value: string): void => {
    setPending(current => ({ ...current, [key]: value }));
    setProblems(current => ({ ...current, [key]: null }));
    changes.clear();
    forgetTest();
  };
  const removeCredential = (key: 'username' | 'password'): void => {
    setPending(current => ({ ...current, [key]: '' }));
    edit({ [`${key}Secret`]: '' });
  };
  // Save files what was typed, saves the setting, and then tries the saved proxy: "set it, see it work".
  const saveAndTest = (setting: BrowserProxySetting | null): void => {
    void (async () => {
      if (!(await fileCredentials())) return;
      const result = await changes.apply(machineSettings(machine, { browserProxy: setting }));
      if (result.kind === 'refused') return;
      onSaved();
      if (setting !== null) await runTest({});
    })();
  };

  const testHint =
    !typed && saved === null
      ? 'Type a proxy address to test it.'
      : `Tries one request through the proxy from ${machineName}.`;
  const now =
    saved === null
      ? 'No proxy: the browser goes direct.'
      : [
          saved.url,
          saved.username === undefined ? 'no sign-in' : 'signs in with a stored username and password',
          saved.bypass.length === 0
            ? null
            : `skips ${String(saved.bypass.length)} ${saved.bypass.length === 1 ? 'address' : 'addresses'}`,
        ]
          .filter(part => part !== null)
          .join(' · ');
  // One half of a username/password pair is not yet a mistake: the other is still to be filled in.
  const halfPair = (filed.usernameSecret === '') !== (filed.passwordSecret === '');
  const testRefused = shown?.kind === 'refused';

  return (
    <SetupSection title="Browser proxy" name="browser-proxy">
      <p className="m-0 min-w-0 break-words text-ui text-fg" data-browser-proxy-current="">
        <span className="font-semibold">Now: </span>
        {now}
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
      <BrowserProxyCredential
        what="Username"
        stored={isStored(draft.usernameSecret, savedNames.usernameSecret)}
        value={pending.username}
        problem={problems.username}
        onChange={value => typedInto('username', value)}
        onRemove={() => removeCredential('username')}
      />
      <BrowserProxyCredential
        what="Password"
        stored={isStored(draft.passwordSecret, savedNames.passwordSecret)}
        value={pending.password}
        problem={problems.password}
        onChange={value => typedInto('password', value)}
        onRemove={() => removeCredential('password')}
      />
      <div className="flex min-w-0 flex-col gap-2">
        <button
          type="button"
          className="w-fit cursor-pointer border-0 bg-transparent p-0 text-meta text-muted underline"
          aria-expanded={expert}
          data-browser-proxy-expert=""
          onClick={() => setExpert(open => !open)}
        >
          Use a different stored secret
        </button>
        {expert ? (
          <>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={`${ids}-username`} className="text-ui font-semibold text-fg">
                Username secret name
              </label>
              <input
                id={`${ids}-username`}
                className="kt-input min-w-0 font-mono"
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder={DEFAULT_USER}
                value={draft.usernameSecret}
                data-browser-proxy-username=""
                onChange={event => edit({ usernameSecret: event.target.value })}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={`${ids}-password`} className="text-ui font-semibold text-fg">
                Password secret name
              </label>
              <input
                id={`${ids}-password`}
                className="kt-input min-w-0 font-mono"
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder={DEFAULT_PASSWORD}
                value={draft.passwordSecret}
                data-browser-proxy-password=""
                onChange={event => edit({ passwordSecret: event.target.value })}
              />
            </div>
          </>
        ) : null}
      </div>
      {wanted.ok || halfPair || testRefused ? null : (
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
          submitLabel={wanted.setting === null ? 'Turn the browser proxy off' : 'Save and test'}
          onSubmit={() => saveAndTest(wanted.setting)}
        >
          <Button
            type="button"
            data-browser-proxy-undo=""
            onClick={() => {
              setDraft(draftOf(saved));
              setPending({ username: '', password: '' });
              setProblems({ username: null, password: null });
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
