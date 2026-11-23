import {
  Button,
  type ChangeAuthority,
  ChangeApplyPanel,
  SetupNote,
  SetupSection,
  useSecretField,
} from '@ferretry/app/ui';
import { SettingSaveBar } from '@ferretry/app';
import { MIN_SECRET_VALUE_LENGTH } from '@ferretry/core-vault/contract';
import { useEffect, useId, useRef, useState } from 'react';
import type { BrowserProxySetting } from '../../../contract/index.ts';
import { type CallClient, listSecretNames, putSecret, reasonOf } from '../../lib/clients.ts';
import { machineInSentence, type SaveOutcome } from './browser-mode-section.tsx';
import { testBrowserProxy } from './browser-proxy-api.ts';
import { type BrowserProxyDraft, draftOf, isSecretName, nameTyped, settingOf } from './browser-proxy-draft.ts';
import { BrowserProxyCredential } from './browser-proxy-credential.tsx';
import { BrowserProxyTestBlock } from './browser-proxy-test-block.tsx';
import type { ProxyTestShown } from './browser-proxy-test-result.tsx';

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
  client,
  machineName,
  authority,
  saved,
  save,
}: {
  readonly client: CallClient;
  /** What this machine is called in the sentence that says it will ask for a passkey. */
  readonly machineName: string;
  /** What this browser may change here; `null` while it is being read. */
  readonly authority: ChangeAuthority | null;
  /** The saved proxy; none means the browser goes direct. */
  readonly saved: BrowserProxySetting | null;
  readonly save: (proxy: BrowserProxySetting | null) => Promise<SaveOutcome>;
}) {
  const ids = useId();
  const [saving, setSaving] = useState(false);
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome | null>(null);
  const [draft, setDraft] = useState<BrowserProxyDraft>(draftOf(saved));
  const [testing, setTesting] = useState(false);
  const [shown, setShown] = useState<ProxyTestShown | null>(null);
  // What was typed into the write-only boxes and not yet filed in the secret store lives only in the two inputs
  // themselves (read to file it, emptied the moment the machine has it); state knows only whether each holds anything.
  const pendingFields = { username: useSecretField(), password: useSecretField() };
  const [problems, setProblems] = useState<{ username: string | null; password: string | null }>({
    username: null,
    password: null,
  });
  // A new SAVED proxy (a save that took, read back) restarts the form from it. The section is NOT remounted for that (a remount
  // would drop what the test just said); the draft is re-based while it renders, and the test result stays.
  const savedKey = JSON.stringify(saved ?? null);
  const [seenSaved, setSeenSaved] = useState(savedKey);
  if (seenSaved !== savedKey) {
    setSeenSaved(savedKey);
    setDraft(draftOf(saved));
    setProblems({ username: null, password: null });
  }
  const testRun = useRef(0);
  const [existing, setExisting] = useState<ReadonlySet<string> | null>(null);
  const [expert, setExpert] = useState(
    [draftOf(saved).usernameSecret, draftOf(saved).passwordSecret].some(
      name => name !== '' && name !== DEFAULT_USER && name !== DEFAULT_PASSWORD,
    ),
  );
  useEffect(() => {
    let live = true;
    listSecretNames(client).then(
      names => {
        if (live && names.health === 'ready') setExisting(names.names);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);
  // Whatever a test said is about the proxy as it was: an edit makes it stale, and an answer still on its
  // way for the old text is dropped.
  const forgetTest = (): void => {
    testRun.current += 1;
    setTesting(false);
    setShown(null);
  };
  const edit = (patch: Partial<BrowserProxyDraft>): void => {
    setDraft(current => ({ ...current, ...patch }));
    setSaveOutcome(null);
    forgetTest();
  };

  const nameFor = (box: string, fallback: string): string => (isSecretName(nameTyped(box)) ? nameTyped(box) : fallback);
  // The form as it will be once what was typed has been filed: a typed value is filed under the name already in
  // the box, else under PROXY_USER / PROXY_PASSWORD.
  const filed: BrowserProxyDraft = {
    ...draft,
    usernameSecret: !pendingFields.username.filled ? draft.usernameSecret : nameFor(draft.usernameSecret, DEFAULT_USER),
    passwordSecret: !pendingFields.password.filled
      ? draft.passwordSecret
      : nameFor(draft.passwordSecret, DEFAULT_PASSWORD),
  };
  const typed = draft.url.trim() !== '';
  const wanted = typed ? settingOf(filed) : ({ ok: true, setting: null } as const);
  const before = JSON.stringify(draftOf(saved));
  const dirty = JSON.stringify(filed) !== before || pendingFields.username.filled || pendingFields.password.filled;
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
  /** Runs one test and shows what it said; answers what it said, or `null` when an edit made the answer stale. */
  const runTest = async (body: { readonly proxy?: BrowserProxySetting }): Promise<ProxyTestShown | null> => {
    testRun.current += 1;
    const mine = testRun.current;
    setTesting(true);
    setShown(null);
    let next: ProxyTestShown;
    try {
      next = { kind: 'result', result: await testBrowserProxy(client, body.proxy) };
    } catch (caught) {
      next = { kind: 'refused', sentence: reasonOf(caught) };
    }
    if (testRun.current !== mine) return null;
    setTesting(false);
    setShown(next);
    return next;
  };
  const refuseTest = (sentence: string): void => {
    testRun.current += 1;
    setTesting(false);
    setShown({ kind: 'refused', sentence });
  };
  // Files what was typed in the secret store, and answers the form as it is once that is done. `null` (with one short sentence
  // on the box) when it cannot be. A value is NEVER filed over a name that is already in the store: the proxy that is live
  // still reads that name, and the new one may yet fail its test. It goes under the next free name instead (PROXY_PASSWORD_2),
  // which nothing reads until a save that worked points the proxy at it.
  const fileCredentials = async (): Promise<BrowserProxyDraft | null> => {
    const boxes = [
      ['username', pendingFields.username.read(), filed.usernameSecret],
      ['password', pendingFields.password.read(), filed.passwordSecret],
    ] as const;
    const short = boxes.filter(([, value]) => value !== '' && value.length < MIN_SECRET_VALUE_LENGTH);
    if (short.length > 0) {
      setProblems(current => ({
        ...current,
        ...Object.fromEntries(
          short.map(([key]) => [key, `Use at least ${String(MIN_SECRET_VALUE_LENGTH)} characters.`]),
        ),
      }));
      return null;
    }
    let result: BrowserProxyDraft = filed;
    if (boxes.every(([, value]) => value === '')) return result;
    // What is in the store NOW (the list read earlier may be old); what was read, or what is saved, when it cannot be asked.
    const taken = new Set<string>([...(existing ?? []), savedNames.usernameSecret, savedNames.passwordSecret]);
    try {
      for (const name of (await listSecretNames(client)).names) taken.add(name);
    } catch {
      // The earlier list and the saved names stand.
    }
    for (const [key, value, base] of boxes) {
      if (value === '') continue;
      let name = base;
      for (let next = 2; taken.has(name); next += 1) name = `${base.slice(0, 60)}_${String(next)}`;
      try {
        await putSecret(client, name, value);
      } catch (caught) {
        setProblems(current => ({ ...current, [key]: reasonOf(caught) }));
        return null;
      }
      taken.add(name);
      setExisting(current => new Set([...(current ?? []), name]));
      pendingFields[key].clear();
      result = { ...result, [`${key}Secret`]: name };
      setDraft(current => ({ ...current, [`${key}Secret`]: name }));
    }
    return result;
  };
  // What a test of the form as filed sends: nothing for the saved proxy, the edited setting when it differs.
  const bodyOf = (form: BrowserProxyDraft): { readonly proxy?: BrowserProxySetting } | null => {
    const setting = settingOf(form);
    return setting.ok && setting.setting !== null
      ? JSON.stringify(form) !== before
        ? { proxy: setting.setting }
        : {}
      : testBody;
  };
  const test = (): void => {
    if (typed && !wanted.ok) {
      refuseTest(wanted.problem);
      return;
    }
    if (testBody === null) return;
    void (async () => {
      const form = await fileCredentials();
      if (form === null) return;
      const body = bodyOf(form);
      if (body !== null) await runTest(body);
    })();
  };
  // Is something filed under this box's name? Until the list has been read, only what was saved is taken to be.
  const isStored = (box: string, savedName: string): boolean => {
    const name = nameTyped(box);
    return isSecretName(name) && (existing === null ? name === savedName : existing.has(name));
  };
  const savedNames = draftOf(saved);
  const typedInto = (key: 'username' | 'password'): void => {
    setProblems(current => ({ ...current, [key]: null }));
    setSaveOutcome(null);
    forgetTest();
  };
  const removeCredential = (key: 'username' | 'password'): void => {
    pendingFields[key].clear();
    edit({ [`${key}Secret`]: '' });
  };
  // Save and test: the proxy is TRIED FIRST, as typed, and only one that works is saved. A failed try writes nothing, so the
  // proxy that was in effect (and every secret it reads) stays exactly as it was. Turning the proxy off has nothing to try.
  const saveAndTest = (setting: BrowserProxySetting | null): void => {
    void (async () => {
      setSaving(true);
      try {
        const form = await fileCredentials();
        if (form === null) return;
        let toSave = setting;
        if (setting !== null) {
          const filedSetting = settingOf(form);
          toSave = filedSetting.ok ? filedSetting.setting : setting;
          const tried = await runTest({ proxy: toSave });
          if (tried === null) return;
          if (tried.kind !== 'result' || !tried.result.reachable) {
            setSaveOutcome({
              kind: 'refused',
              sentence: `Not saved: the proxy did not work, so ${saved === null ? 'the browser still goes direct' : 'the proxy saved before stays in effect'}.`,
            });
            return;
          }
        }
        const result = await save(toSave);
        setSaveOutcome(result);
        // A held setting is not the saved one yet, so there is nothing saved to try again.
        if (result.kind === 'saved' && toSave !== null) await runTest({});
      } finally {
        setSaving(false);
      }
    })();
  };

  const testHint =
    !typed && saved === null
      ? 'Type a proxy address to test it.'
      : `Tries one request through the proxy from ${machineInSentence(machineName)}.`;
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
    <SetupSection title="Browser proxy" name="browser-proxy" saves="on-save">
      <p className="m-0 min-w-0 break-words text-ui text-fg" data-browser-proxy-current="">
        <span className="font-semibold">Now: </span>
        {now}
      </p>
      {/* A field is never wider than 28rem; username and password sit side by side when the PANEL (not the window) has room. */}
      <div className="min-w-0 [container-type:inline-size]">
        <div className="grid min-w-0 grid-cols-1 gap-3 [@container(min-width:640px)]:grid-cols-2 [@container(min-width:640px)]:gap-x-8">
          <div className="flex min-w-0 max-w-[28rem] flex-col gap-1 [@container(min-width:640px)]:col-span-2">
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
          <div className="flex min-w-0 max-w-[28rem] flex-col gap-1 [@container(min-width:640px)]:col-span-2">
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
            field={pendingFields.username}
            problem={problems.username}
            onChanged={() => typedInto('username')}
            onRemove={() => removeCredential('username')}
          />
          <BrowserProxyCredential
            what="Password"
            stored={isStored(draft.passwordSecret, savedNames.passwordSecret)}
            field={pendingFields.password}
            problem={problems.password}
            onChanged={() => typedInto('password')}
            onRemove={() => removeCredential('password')}
          />
        </div>
      </div>
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
            <div className="flex min-w-0 max-w-[28rem] flex-col gap-1">
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
            <div className="flex min-w-0 max-w-[28rem] flex-col gap-1">
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
        disabled={testBody === null && !(typed && !wanted.ok)}
        testing={testing}
        hint={testHint}
        shown={shown}
        onTest={test}
      />
      {wanted.ok && dirty ? (
        <div className="flex min-w-0 flex-col gap-2" data-browser-proxy-save-panel="">
          {saveOutcome?.kind === 'refused' ? (
            <SetupNote live tone="warn" name="browser-proxy-save-refusal">
              {saveOutcome.sentence}
            </SetupNote>
          ) : null}
          {saveOutcome?.kind === 'pending' ? (
            <SetupNote live tone="warn" name="browser-proxy-held">
              {saveOutcome.sentence}
            </SetupNote>
          ) : null}
          <ChangeApplyPanel
            machineName={machineName}
            authority={authority}
            busy={saving}
            refusal={null}
            submitLabel={wanted.setting === null ? 'Turn the browser proxy off' : 'Save and test'}
            onSubmit={() => saveAndTest(wanted.setting)}
          >
            <Button
              type="button"
              data-browser-proxy-undo=""
              onClick={() => {
                setDraft(draftOf(saved));
                pendingFields.username.clear();
                pendingFields.password.clear();
                setProblems({ username: null, password: null });
                forgetTest();
              }}
            >
              Keep what is saved
            </Button>
          </ChangeApplyPanel>
        </div>
      ) : (
        // The Save bar is there from the first paint; the panel above replaces it once there is something valid to save.
        <SettingSaveBar
          dirty={dirty}
          blocked
          saved={saveOutcome?.kind === 'saved' && !dirty}
          saveLabel="Save and test"
          onSave={() => undefined}
          onDiscard={() => {
            setDraft(draftOf(saved));
            pendingFields.username.clear();
            pendingFields.password.clear();
            setProblems({ username: null, password: null });
            forgetTest();
          }}
        />
      )}
      <p className="m-0 text-meta leading-base text-muted" data-browser-proxy-hint="">
        Applies the next time the browser on {machineInSentence(machineName)} starts.
      </p>
    </SetupSection>
  );
}
