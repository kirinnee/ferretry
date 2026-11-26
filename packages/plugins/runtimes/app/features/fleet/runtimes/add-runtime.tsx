/**
 * Advanced: add a runtime by hand. Most people never need this: every ready login already has a runtime, so it shows up in
 * New ferret by itself. This is for choosing a different profile, and it is ONE SHORT FORM: **Login** and one Create
 * button. Everything else (a new login, its sign-in, **Profile** with the model it starts on, which CLI a login that
 * drives both runs) is collapsed under ONE "More" disclosure. A login, a runtime and a profile are named in plain words
 * (`runtimeDisplayName`, `profileDisplayName`). The runtime's stored id is made for the person and never typed or shown.
 *
 * A missing login is added IN PLACE ("+ Add a new login" opens Logins' add-login panel right under the field, through the slot
 * this page offers) and comes back picked; a login that needs sign-in is signed in under it the same way. Profiles are built
 * in Settings › Profiles, linked from here. The edge cases keep their places: no logins (E12), a login that needs sign-in
 * (E13), profiles that do not apply to the login's CLI (E14, only the ones that fit are offered), the same login and profile
 * already being a runtime (E15), and a clashing or invalid name (E16).
 */

import {
  type LayeredProfileView,
  type AccountChangeView,
  type LoginNameSource,
  type MachineView,
  loginDisplayName,
  modelDisplayName,
  profileDisplayName,
  runtimeAccounts,
  runtimeDisplayName,
  terminalSignInWords,
} from '../../../../contract/index.ts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../../../ui.ts';
import { Button, SelectBox } from '../../../ui.ts';

import { credentialHarnesses, HARNESSES, type HarnessKind, harnessesName } from '../../../lib/logins-view.ts';
import { AccountStatus } from '../shell/account-status.tsx';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { currentDaemon, followInApp, tabHref } from '../shell/machine-route.ts';
import { AddLoginSlot, SignInSlot } from './add-runtime-login-slots.tsx';
import type { MachineData } from './machine-data.ts';
import {
  harnessInstalled,
  profileFit,
  runsHarness,
  sameLoginAndProfile,
  suggestedRuntimeName,
} from './runtimes-model.ts';
import { harnessName } from '../../../../contract/harness-words.ts';

/** What the person has changed from the defaults; every field not touched follows the machine's own choice. */
interface AddRuntimeDraft {
  readonly credentialId: string | null;
  readonly profile: string | null;
  /** E15: "Add another anyway". */
  readonly addAnother: boolean;
  /** **Runs**: the CLI the person chose for a login that drives both. `null`: not chosen. */
  readonly runs: HarnessKind | null;
  readonly plainProfile: boolean;
  readonly plainName: string | null;
}

const EMPTY: AddRuntimeDraft = {
  credentialId: null,
  profile: null,
  addAnother: false,
  runs: null,
  plainProfile: false,
  plainName: null,
};

export interface AddRuntimeProps {
  readonly data: MachineData;
  readonly reload: () => Promise<MachineData | null>;
  readonly changes: AccountChanges;
  readonly machine: MachineView | null;
  readonly machineName: string;
  readonly online: boolean;
  /** Leave: back to the list (`null`), or to the runtime that was made. */
  readonly onFinish: (open: string | null) => void;
  /** Supplied in tests. */
  readonly pollMs?: number;
}

/** One labelled field. */
function Field({
  title,
  name,
  htmlFor,
  children,
}: {
  readonly title: string;
  readonly name: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-add-runtime-part={name}>
      <label htmlFor={htmlFor} className="text-ui font-semibold text-fg">
        {title}
      </label>
      {children}
    </div>
  );
}

/** The model a profile starts a runtime on, read from its model set component; `undefined` when it has none to name. */
const profileModel = (profile: LayeredProfileView, data: MachineData): string | undefined => {
  const reference = profile.layers.findLast(layer => layer.startsWith('modelSets/'));
  const found = data.components?.kinds
    .flatMap(kind => kind.components)
    .find(component => component.reference === reference);
  return found?.detail.kind === 'modelSets' ? found.detail.default : undefined;
};

export function AddRuntime({ data, reload, changes, machine, machineName, online, onFinish }: AddRuntimeProps) {
  const [draft, setDraft] = useState<AddRuntimeDraft>(EMPTY);
  const [made, setMade] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [review, setReview] = useState<{ readonly staged: AccountChangeView; readonly name: string } | null>(null);
  const runtimes = data.runtimes.runtimes;
  // Claude first, then Codex: the order the picker in New ferret groups them in.
  const ordered = HARNESSES.flatMap(candidate => data.credentials.logins.filter(item => item.harness === candidate));
  const registered = new Set(machine?.tools.map(tool => tool.harness) ?? HARNESSES);
  const credentials = [
    ...ordered,
    ...data.credentials.logins.filter(
      login => !ordered.includes(login) && login.harnesses.some(key => registered.has(key)),
    ),
  ];
  const credential = credentials.find(candidate => candidate.id === draft.credentialId) ?? credentials[0];
  // A login that drives both CLIs runs the one chosen under Runs, else the one its profile is scoped to.
  const harnesses = credential === undefined ? [] : credentialHarnesses(credential).filter(key => registered.has(key));
  const dual = harnesses.length > 1;
  const harness = credential === undefined ? undefined : runsHarness(harnesses, draft.runs);
  const native = harness !== undefined && !HARNESSES.includes(harness);
  const harnessLabel = (key: HarnessKind): string =>
    machine?.tools.find(tool => tool.harness === key)?.label ?? harnessName(key);
  // What the daemon will check a pin against: the models the tool's own descriptor reports for this login, which it
  // reads for a login with no runtime yet too; a runtime already on it says the same.
  const nativeChoices: readonly { readonly id: string; readonly available?: boolean }[] =
    machine?.nativeModels
      ?.find(item => item.login === credential?.id && item.harness === harness)
      ?.models.map(id => ({ id })) ??
    runtimes.find(item => item.credential.id === credential?.id && item.harness === harness)?.discovery?.choices ??
    [];
  const fitting = data.profiles.profiles.filter(
    profile =>
      harness !== undefined &&
      profileFit(profile, harness, registered.has(harness), {
        model: profileModel(profile, data),
        choices: nativeChoices,
      }).fits,
  );
  // The preset a person most likely wants: the first that is not already a runtime on this login.
  const unused = fitting.find(
    candidate => credential === undefined || sameLoginAndProfile(runtimes, credential.id, candidate.name) === undefined,
  );
  const chosenProfile = fitting.find(candidate => candidate.name === draft.profile) ?? unused ?? fitting[0];
  const needsPlainProfile = native && fitting.length === 0;
  const createPlainProfile = needsPlainProfile && draft.plainProfile;
  const profileName = chosenProfile?.name ?? (createPlainProfile ? (draft.plainName ?? 'plain') : undefined);
  const accounts = runtimeAccounts(data.credentials.logins);
  const loginName = (item: LoginNameSource): string => loginDisplayName(item, data.credentials.logins, accounts);
  const set = (patch: Partial<AddRuntimeDraft>): void => setDraft(current => ({ ...current, ...patch }));
  const pickLogin = (id: string): void =>
    setDraft(current => ({
      ...current,
      credentialId: id,
      profile: null,
      addAnother: false,
      runs: null,
      plainProfile: false,
      plainName: null,
    }));
  // A login added in place: re-read the machine so it is listed, close the panel, and come back with it picked.
  const added = (id: string): void => {
    void reload().then(() => {
      setAdding(false);
      pickLogin(id);
    });
  };

  const back = (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="kt-btn--flush-start"
        data-page-back=""
        onClick={() => onFinish(null)}
      >
        <ChevronLeft size={16} aria-hidden="true" />
        Runtimes
      </Button>
      <h3 className="m-0 mt-2 text-title font-semibold text-fg">Advanced: add a runtime</h3>
      <p className="m-0 mt-1 text-cell leading-base text-muted" data-add-runtime-intro="">
        {native ? (
          'Choose an API-key or endpoint login, then choose a profile or create a plain one.'
        ) : (
          <>
            Every ready login already has a runtime on {machineName}, so you don’t need this to start a ferret. Add one
            to pick another profile.
          </>
        )}
      </p>
    </div>
  );

  if (made !== null) {
    const runtime = runtimes.find(item => item.name === made);
    const signInFirst = runtime?.credential.status === 'needs_sign_in';
    return (
      <section className="flex min-w-0 flex-col gap-4" data-add-runtime="" data-add-runtime-made={made}>
        {back}
        <div role="status" className="kt-panel flex flex-col gap-1 p-panel" data-add-runtime-done="">
          <p className="m-0 text-row font-semibold text-ok">
            {runtime === undefined
              ? made
              : runtimeDisplayName(runtime, runtimes, runtimeAccounts(data.credentials.logins))}{' '}
            {signInFirst ? 'is added' : 'is ready to launch'}
          </p>
          <p className="m-0 text-cell leading-base text-muted">
            {runtime === undefined
              ? ''
              : `${runtime.harnessDisplayName ?? harnessName(runtime.harness)} · ${profileDisplayName(runtime.profile)} profile`}
            {signInFirst ? '. Sign in to its login before you launch it.' : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" data-add-runtime-finish="list" onClick={() => onFinish(null)}>
            Back to Runtimes
          </Button>
          <Button type="button" variant="primary" data-add-runtime-finish="open" onClick={() => onFinish(made)}>
            Open this runtime
          </Button>
        </div>
      </section>
    );
  }

  if (review !== null) {
    const documents = review.staged.preview?.kind === 'apply' ? review.staged.preview.documents : [];
    const confirm = async () => {
      const result = await changes.applyStaged(review.staged);
      if (result.kind !== 'applied') return;
      await reload();
      setMade(review.name);
      setReview(null);
    };
    return (
      <section className="flex min-w-0 flex-col gap-4" data-native-runtime-review="">
        {back}
        <h3 className="m-0 text-row font-semibold text-fg">Create runtime and plain profile</h3>
        <p className="m-0 text-cell text-muted">Review both files. They are saved together, or neither is changed.</p>
        <ul className="kt-panel m-0 flex list-none flex-col gap-2 p-panel" data-native-runtime-writes="">
          {documents.map(document => {
            const slash = document.path.lastIndexOf('/') + 1;
            return (
              <li key={document.path} className="font-mono text-cell">
                <span className="text-muted">{document.path.slice(0, slash)}</span>
                <wbr />
                <span className="inline-block max-w-full break-words">{document.path.slice(slash)}</span>
              </li>
            );
          })}
        </ul>
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Create runtime and profile"
          onSubmit={() => void confirm()}
        >
          <Button
            type="button"
            variant="ghost"
            disabled={changes.busy}
            onClick={() => {
              changes.clear();
              setReview(null);
            }}
          >
            Back
          </Button>
        </ChangeApplyPanel>
      </section>
    );
  }

  const duplicate =
    credential === undefined || chosenProfile === undefined
      ? undefined
      : sameLoginAndProfile(runtimes, credential.id, chosenProfile.name);
  // The stored id is made for the person (harness plus profile, made unique) and never typed or shown: every screen names
  // the runtime in words (`runtimeDisplayName`).
  const suggested =
    harness === undefined || profileName === undefined ? '' : suggestedRuntimeName(harness, profileName, runtimes);
  const ready =
    credential !== undefined &&
    profileName !== undefined &&
    profileName.trim() !== '' &&
    (duplicate === undefined || draft.addAnother);
  const model = chosenProfile === undefined ? undefined : profileModel(chosenProfile, data);
  // The model in its catalog's words: read from a runtime already on this login and CLI, else the id as the profile names it.
  const modelName =
    model === undefined
      ? undefined
      : modelDisplayName(
          model,
          runtimes.find(item => item.credential.id === credential?.id && item.harness === harness)?.models?.choices,
        );

  const create = async (): Promise<void> => {
    if (credential === undefined || profileName === undefined) return;
    const change = {
      kind: 'runtime.put' as const,
      name: suggested,
      credential: credential.id,
      profile: profileName,
      ...(createPlainProfile ? { createPlainProfile: true as const } : {}),
      ...(harness !== undefined && (dual || !HARNESSES.includes(harness)) ? { harness } : {}),
      create: true,
      ...(draft.addAnother ? { addAnother: true } : {}),
    };
    if (createPlainProfile) {
      const result = await changes.stage(change);
      if (result.kind === 'staged') setReview({ staged: result.staged, name: suggested });
      return;
    }
    const result = await changes.apply(change);
    if (result.kind !== 'applied') return;
    await reload();
    setMade(suggested);
  };

  const missing = credential === undefined ? [] : harnesses.filter(candidate => !harnessInstalled(machine, candidate));
  const needsSignIn = credential?.status.word === 'needs_sign_in';
  const signInWords =
    credential === undefined ? undefined : terminalSignInWords(credential.store, credential.status.word);
  const noLogins = credentials.length === 0;
  // A login is added and signed in right here: Logins contributes both panels to the two slots this
  // page offers (add-runtime-login-slots.tsx), and without them each falls back to the Sign-ins link.
  const addLogin = <AddLoginSlot machineName={machineName} open={adding} onOpenChange={setAdding} onAdded={added} />;

  return (
    <section className="flex min-w-0 flex-col gap-5" data-add-runtime="">
      {back}

      <Field title="Login" name="login" htmlFor="add-runtime-login">
        {noLogins ? (
          <p className="m-0 text-cell leading-base text-muted" data-add-runtime-no-logins="">
            There are no logins on {machineName} yet. Add one below: sign in to Claude Code or Codex, or use a provider
            key.
          </p>
        ) : (
          <>
            <span className="contents" data-add-runtime-credential-select="">
              <SelectBox
                id="add-runtime-login"
                label="Login"
                value={credential?.id ?? ''}
                onChange={pickLogin}
                options={credentials.map(item => ({
                  value: item.id,
                  label: loginName(item),
                }))}
              />
            </span>
            {credential === undefined ? null : (
              <span
                className="inline-flex flex-wrap items-center gap-1 text-cell text-muted"
                data-add-runtime-login-sub=""
              >
                <AccountStatus
                  word={credential.status.word}
                  showLabel
                  {...(signInWords === undefined ? {} : { label: signInWords })}
                />
                {missing.length === 0 ? '' : ` · ${harnessesName(missing)} isn’t installed here`}
              </span>
            )}
          </>
        )}
        {noLogins ? addLogin : null}
      </Field>

      {needsPlainProfile ? (
        <div className="kt-panel flex flex-col gap-2 p-panel" data-native-plain-profile="">
          <label className="flex min-h-control items-center gap-2 text-cell text-fg">
            <input
              type="checkbox"
              checked={draft.plainProfile}
              data-create-plain-profile=""
              onChange={event => set({ plainProfile: event.target.checked })}
            />
            Create a plain profile with it
          </label>
          <p className="m-0 text-meta text-muted">
            An empty profile for {harness === undefined ? 'this tool' : harnessLabel(harness)}. Choose its model when
            starting a ferret.
          </p>
          {createPlainProfile ? (
            <Field title="Profile name" name="plain-profile" htmlFor="plain-profile-name">
              <input
                id="plain-profile-name"
                className="kt-input w-full"
                value={profileName ?? ''}
                onChange={event => set({ plainName: event.target.value })}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      {duplicate === undefined ? null : (
        <div role="status" className="kt-panel flex flex-col gap-2 p-panel" data-add-runtime-duplicate="">
          <p className="m-0 text-row font-semibold text-fg">
            <span data-add-runtime-duplicate-name="">{runtimeDisplayName(duplicate, runtimes, accounts)}</span> already
            uses this login and profile.
          </p>
          <label className="flex min-h-control items-center gap-2 text-cell text-fg">
            <input
              type="checkbox"
              data-duplicate-ok=""
              checked={draft.addAnother}
              onChange={event => set({ addAnother: event.target.checked })}
            />
            Add another anyway
          </label>
        </div>
      )}

      {credential === undefined ? null : (
        <details className="min-w-0" data-add-runtime-more="" open={adding || needsSignIn}>
          <summary className="min-h-control cursor-pointer text-cell font-semibold text-fg">More</summary>
          <div className="mt-2 flex flex-col gap-5">
            <div className="flex flex-col gap-2" data-add-runtime-part="login-more">
              {addLogin}
              {needsSignIn ? (
                <div className="m-0 text-cell leading-base text-muted" data-add-runtime-needs-sign-in="">
                  This login needs sign-in before you launch.{' '}
                  <SignInSlot
                    machineName={machineName}
                    login={credential.id}
                    harness={credential.harness}
                    onSignedIn={() => void reload()}
                  />
                </div>
              ) : null}
            </div>

            <Field title="Profile" name="profile" htmlFor="add-runtime-profile">
              {fitting.length === 0 ? (
                <p className="m-0 text-cell text-muted" data-add-runtime-no-profiles="">
                  No profile on {machineName} applies to {harness === undefined ? 'this login' : harnessLabel(harness)}{' '}
                  yet.
                </p>
              ) : (
                <span className="contents" data-add-runtime-profile-select="">
                  <SelectBox
                    id="add-runtime-profile"
                    label="Profile"
                    value={chosenProfile?.name ?? ''}
                    onChange={next => set({ profile: next, addAnother: false })}
                    options={fitting.map(profile => ({
                      value: profile.name,
                      label: profileDisplayName(profile.name),
                    }))}
                  />
                </span>
              )}
              {model === undefined ? null : (
                <span className="text-meta text-muted" data-add-runtime-model="">
                  Starts on <span>{modelName}</span>
                </span>
              )}
              <a
                href={tabHref(currentDaemon(), machineName, 'profiles')}
                onClick={followInApp}
                className="inline-flex min-h-control items-center gap-1 self-start text-cell font-semibold text-accent underline"
                data-add-runtime-profiles-link=""
              >
                Build or change profiles in Profiles
                <ChevronRight size={14} aria-hidden="true" />
              </a>
            </Field>

            {dual ? (
              <div className="flex flex-col gap-2" data-add-runtime-part="runs">
                <p className="m-0 text-cell leading-base text-muted" data-add-runtime-runs={harness}>
                  {harnesses.length === 2
                    ? 'This login drives both CLIs. The runtime runs one of them'
                    : 'This login drives several tools. Choose one for this runtime'}
                  {draft.runs === null ? ` — ${harnessLabel(harnesses[0]!)} until you choose` : ''}.
                </p>
                <div className="flex flex-wrap gap-2">
                  {harnesses.map(candidate => (
                    <label
                      key={candidate}
                      className={cn(
                        'kt-panel flex min-h-control min-w-0 cursor-pointer items-center gap-2 px-3 py-2',
                        candidate === harness && 'border-accent',
                      )}
                      data-add-runtime-runs-option={candidate}
                    >
                      <input
                        type="radio"
                        name="add-runtime-runs"
                        checked={candidate === harness}
                        onChange={() =>
                          set({
                            runs: candidate,
                            profile: null,
                            addAnother: false,
                            plainProfile: false,
                            plainName: null,
                          })
                        }
                      />
                      <span className="text-row font-semibold text-fg">{harnessLabel(candidate)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </details>
      )}

      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        busyLabel="Creating…"
        refusal={changes.refusal}
        submitLabel="Create runtime"
        disabled={!ready || !online}
        onSubmit={() => void create()}
      />
    </section>
  );
}
