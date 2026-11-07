import type { ChosenFerretAccount, NewFerretAccountSlotProps } from '@ferretry/core-ferrets/contract';
import { type ComponentType, type ReactNode, useEffect, useState } from 'react';
import { ModelSelect } from '../../components/model-select.tsx';
import type { LiveFerretsClient } from '../../lib/client.ts';
import { Button, Card, cn, FastSwitch, PanelBody, Textarea } from '../../ui.ts';
import { FolderPicker } from './folder-picker.tsx';
import { daemonHomeHref, ferretChatHref, runtimesSettingsHref } from './hrefs.ts';
import { canStartFerret, emptyNewFerretDraft, type NewFerretDraft, startFerret } from './new-ferret-draft.ts';
import { type FolderRead, LOADING_FOLDERS, readRecentFolders } from './recent-folders.ts';
import { type AccountSlotProps, ShellAccountSlot } from './shell-account-slot.tsx';

/** The runtime a first run makes for Claude Code — the example a person can actually type. */
const FIRST_RUN_RUNTIME = 'claude-default';

/** The one sentence about what fast mode costs, said once in the form's hint. */
export const FAST_COST_NOTE = 'Fast mode can cost more.';

type TextDraftField = Exclude<keyof NewFerretDraft, 'mode' | 'fast' | 'remoteControl'>;

const fieldId = (field: TextDraftField): string => `fy-new-ferret-${field}`;

/** The sentence saying why Create is unavailable, and the button's description. */
const CREATE_BLOCKER_ID = 'fy-new-ferret-create-blocker';

/**
 * What the Folder box says while empty: both spellings of the box (the picker and the plain fallback) accept a typed
 * path, so both say so; the picker's list is the easy way on a phone, and typing is always the way out.
 */
const TYPED_PATH_PLACEHOLDER = 'Full path, e.g. /home/you/my-project';
const PICKED_PATH_PLACEHOLDER = 'Choose a folder, or type its full path';

/** The Runtime label's id, which the picker (or its typed fallback) is named by. */
const RUNTIME_LABEL_ID = 'fy-new-ferret-runtime-label';

/** The model box's suggestion list, referenced by the input's own `list`. */
const MODEL_LIST_ID = 'fy-new-ferret-model-options';

const REMOTE_CONTROL_ID = 'fy-new-ferret-remote-control';
const REMOTE_CONTROL_REASON_ID = 'fy-new-ferret-remote-control-reason';
/** Codex has no Remote Control surface, so its ferrets can never ask for one. */
const REMOTE_CONTROL_CODEX_REASON = 'Codex has no Remote Control.';

/**
 * WHAT A CHOSEN RUNTIME MAY DO TO THE MODEL BOX, WHICH IS EXACTLY ONE THING.
 *
 * It may suggest. It may not write: a blank model means "this runtime's own default", the daemon resolves that itself,
 * and typing the default in would turn it into a pin the reader never asked for. A wrapper name alone is not enough
 * either: in a control whose typed value is its output, a reader who chose one runtime and then typed another has
 * changed the answer, and the first runtime's models no longer describe the ferret this form is about to start.
 */
const chosenForDraft = (chosen: ChosenFerretAccount | null, runtime: string): ChosenFerretAccount | null =>
  chosen === null || chosen.wrapper !== runtime.trim() ? null : chosen;

const modelSuggestions = (account: ChosenFerretAccount | null): readonly string[] =>
  account === null ? [] : account.models.filter(model => model.available).map(model => model.id);

/**
 * The model box's placeholder, from the same chosen runtime under the same fence — or nothing at all. A placeholder is
 * not a value, so naming the runtime's own default here pins nothing; it tells a reader what a blank box will get them.
 */
const modelPlaceholder = (account: ChosenFerretAccount | null): string =>
  account?.defaultModel ? `default: ${account.defaultModel}` : '';

const FAST_REASON_ID = 'fy-new-ferret-fast-reason';

/** Why the chosen model cannot launch in fast mode, or nothing when it can or nobody can say. */
export const fastUnavailableReason = (account: ChosenFerretAccount | null, typed: string): string | undefined => {
  if (account === null) return undefined;
  const id = typed.trim() === '' ? (account.defaultModel ?? undefined) : typed.trim();
  const model = account.models.find(candidate => candidate.id === id);
  return model?.fast === false ? `${model.label ?? model.id} has no fast mode.` : undefined;
};

/** What each mode MEANS to the person starting it, one short line each. */
const MODE_MEANING: Readonly<Record<NewFerretDraft['mode'], string>> = {
  auto: 'the agent works through your request on its own',
  interactive: 'opens a live terminal you type into, like a chat',
};

/**
 * Why `Create ferret` cannot be pressed yet, in the reader's words — or `null` when it can. `canStartFerret` owns the
 * decision; this only names it, checking the same facts in the same order so the sentence can never describe a
 * different blocker from the one actually holding the button.
 */
const createBlocker = (draft: NewFerretDraft, submitting: boolean, noRunnableAccount: boolean): string | null => {
  if (submitting) return null;
  if (draft.runtime.trim() === '') {
    return noRunnableAccount ? 'No runtime can run a ferret yet — add one first.' : 'Choose a runtime first.';
  }
  if (draft.folder.trim() === '') return 'Choose the folder the agent works in first.';
  return draft.mode === 'auto' && draft.prompt.trim() === '' ? 'Say what you want the agent to do first.' : null;
};

export interface NewFerretPageProps {
  /** The daemon this page is on: the slot's panels are drawn for it. */
  readonly daemon: string;
  /** The per-daemon client; every read and the one write go through it by route key. */
  readonly client: LiveFerretsClient;
  /** Receives in-app addresses for both cancel and a successful start. */
  readonly onNavigate: (path: string) => void;
  /** "← Home": a step back through history when that is where the reader came from. Absent, an ordinary `onNavigate`. */
  readonly onBack?: (path: string) => void;
  /** Where "back" leads and what it is called. Absent, the daemon's home. */
  readonly backPlace?: { readonly path: string; readonly label: string };
  /**
   * The runtime a Launch button named (`?agent=` on this page's address). A HINT ONLY: the runtime picker fills it in
   * when it offers that runtime as usable and ignores it otherwise. Nothing starts from it.
   */
  readonly initialAgent?: string;
  /** What draws the runtime field's slot. The shell's by default; a test hands a stand-in. */
  readonly AccountSlot?: ComponentType<AccountSlotProps>;
}

/**
 * The new-ferret page.
 *
 * NOTHING ON THIS SCREEN WRITES TO THE HOST EXCEPT `Create ferret`. Choosing a recent folder registers nothing,
 * choosing a runtime probes nothing, and mounting the form runs no check — the ferret list read behind the Folder box
 * is all the traffic it causes.
 */
export function NewFerretPage({
  daemon,
  client,
  onNavigate,
  onBack = onNavigate,
  backPlace,
  initialAgent,
  AccountSlot = ShellAccountSlot,
}: NewFerretPageProps) {
  const [draft, setDraft] = useState<NewFerretDraft>(emptyNewFerretDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chosenRuntime, setChosenRuntime] = useState<ChosenFerretAccount | null>(null);
  const [noRunnableAccount, setNoRunnableAccount] = useState(false);
  const [folders, setFolders] = useState<FolderRead>(LOADING_FOLDERS);

  // The Folder box's catalogue: one read of the daemon's ferrets. A failure is a status, never a throw.
  useEffect(() => {
    let live = true;
    readRecentFolders(client).then(
      recent => {
        if (live) setFolders({ status: 'ready', folders: recent, error: null });
      },
      (caught: unknown) => {
        if (live)
          setFolders(current => ({
            status: 'error',
            folders: current.folders,
            error: caught instanceof Error && caught.message !== '' ? caught.message : null,
          }));
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const update = (field: TextDraftField, value: string): void => setDraft(current => ({ ...current, [field]: value }));
  const canSubmit = canStartFerret(draft, submitting);
  const homePath = daemonHomeHref(daemon);
  const back = backPlace ?? { path: homePath, label: '← Home' };
  const chosen = chosenForDraft(chosenRuntime, draft.runtime);
  const models = modelSuggestions(chosen);
  const blocker = createBlocker(draft, submitting, noRunnableAccount);
  // A model the panel says has no fast mode cannot be launched with it, so the switch says why it is unavailable and
  // the request never carries it (the daemon would refuse it too).
  const fastReason = fastUnavailableReason(chosen, draft.model);
  const remoteControlReason = chosen?.kind === 'codex' ? REMOTE_CONTROL_CODEX_REASON : undefined;
  const typedRuntime = (
    <input
      className="kt-input w-full font-mono"
      id={fieldId('runtime')}
      onChange={event => update('runtime', event.target.value)}
      placeholder={`e.g. ${FIRST_RUN_RUNTIME}`}
      value={draft.runtime}
    />
  );
  const slot: NewFerretAccountSlotProps = {
    value: draft.runtime,
    onValueChange: value => update('runtime', value),
    onChosen: setChosenRuntime,
    fallbackId: fieldId('runtime'),
    labelId: RUNTIME_LABEL_ID,
    fallbackPlaceholder: `e.g. ${FIRST_RUN_RUNTIME}`,
    noAccounts: (
      <NoFerretAccounts
        onOpenSettings={() => onNavigate(runtimesSettingsHref(daemon))}
        onShown={setNoRunnableAccount}
      />
    ),
    ...(initialAgent === undefined ? {} : { preferred: initialAgent }),
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const id = await startFerret(client, {
        ...draft,
        fast: draft.fast && fastReason === undefined,
        remoteControl: draft.remoteControl && remoteControlReason === undefined,
      });
      onNavigate(ferretChatHref(daemon, id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSubmitting(false);
    }
  };

  return (
    <main
      aria-labelledby="new-ferret-heading"
      className="mx-auto flex h-full min-h-0 w-full max-w-[720px] flex-1 flex-col overflow-y-auto px-3 pb-3 sm:px-0"
    >
      <div className="mb-3 mt-3 flex items-center gap-2.5">
        <button className="text-meta text-muted hover:text-fg" onClick={() => onBack(back.path)} type="button">
          {back.label}
        </button>
        <h1 className="m-0 text-title font-semibold tracking-tight" id="new-ferret-heading">
          New ferret
        </h1>
      </div>

      <Card>
        <PanelBody className="space-y-5">
          <FerretField
            hint="what will run this ferret"
            inputId={fieldId('runtime')}
            label="Runtime"
            labelId={RUNTIME_LABEL_ID}
          >
            <AccountSlot daemon={daemon} fallback={typedRuntime} slot={slot} />
          </FerretField>

          <FerretField hint="the folder the agent works in" inputId={fieldId('folder')} label="Folder">
            <FolderPicker
              id={fieldId('folder')}
              label="Folder"
              onValueChange={value => update('folder', value)}
              placeholder={
                folders.folders === null && folders.status === 'error'
                  ? TYPED_PATH_PLACEHOLDER
                  : PICKED_PATH_PLACEHOLDER
              }
              read={folders}
              value={draft.folder}
            />
          </FerretField>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <FerretField hint="blank = runtime default" inputId={fieldId('model')} label="Model override">
              {chosen?.modelCatalog === undefined ? (
                <>
                  {models.length === 0 ? null : (
                    <datalist id={MODEL_LIST_ID}>
                      {models.map(model => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  )}
                  <input
                    className="kt-input w-full font-mono"
                    id={fieldId('model')}
                    list={models.length === 0 ? undefined : MODEL_LIST_ID}
                    onChange={event => update('model', event.target.value)}
                    placeholder={modelPlaceholder(chosen)}
                    value={draft.model}
                  />
                </>
              ) : (
                // A login with a model catalog (docs/model-catalog.md): exactly its models.
                <ModelSelect
                  customIds={chosen.modelCatalog.customIds}
                  defaultModel={chosen.defaultModel}
                  id={fieldId('model')}
                  models={chosen.models}
                  onChange={value => update('model', value)}
                  value={draft.model}
                />
              )}
            </FerretField>

            <fieldset>
              <legend className="mb-1.5 flex items-baseline gap-2">
                <span className="text-ui font-semibold text-fg">Mode</span>
                <span className="text-meta text-faint">how the agent runs</span>
              </legend>
              <div
                aria-label="Ferret mode"
                className="inline-flex rounded-control border border-border bg-surface-2 p-0.5"
                role="toolbar"
              >
                {(['auto', 'interactive'] as const).map(mode => (
                  <button
                    aria-pressed={draft.mode === mode}
                    className={cn(
                      'h-control-sm rounded-control px-3 text-ui font-medium transition-colors',
                      draft.mode === mode ? 'bg-surface text-fg shadow-control' : 'text-muted hover:text-fg',
                    )}
                    key={mode}
                    onClick={() => setDraft(current => ({ ...current, mode }))}
                    type="button"
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <dl className="m-0 mt-1.5 grid gap-0.5 text-meta leading-base text-muted" data-new-ferret-mode-meaning="">
                {(['auto', 'interactive'] as const).map(mode => (
                  <div key={mode}>
                    <dt className="inline font-medium text-fg-soft">{mode}</dt>{' '}
                    <dd className="m-0 inline">— {MODE_MEANING[mode]}</dd>
                  </div>
                ))}
              </dl>
            </fieldset>
          </div>

          <div data-new-ferret-fast="">
            <FastSwitch
              ariaLabel="Fast mode"
              disabled={fastReason !== undefined}
              {...(fastReason === undefined ? {} : { disabledReason: fastReason })}
              onPress={() => setDraft(current => ({ ...current, fast: !current.fast }))}
              pressed={draft.fast && fastReason === undefined}
              reasonId={FAST_REASON_ID}
              variant="field"
            />
            {fastReason === undefined ? null : (
              <p className="sr-only" id={FAST_REASON_ID}>
                {fastReason}
              </p>
            )}
            <p className="m-0 mt-1.5 text-meta leading-base text-muted">
              Faster output on models that offer it. {FAST_COST_NOTE}
            </p>
          </div>

          <details className="rounded-control border border-border-strong px-3 py-2" data-new-ferret-advanced="">
            <summary className="cursor-pointer text-ui font-medium text-fg-soft">Advanced options</summary>
            <div className="mt-2" data-new-ferret-remote-control="">
              <label className="flex min-h-[44px] items-start gap-sm text-ui text-fg" htmlFor={REMOTE_CONTROL_ID}>
                <input
                  aria-describedby={remoteControlReason === undefined ? undefined : REMOTE_CONTROL_REASON_ID}
                  checked={draft.remoteControl && remoteControlReason === undefined}
                  className="mt-1 h-4 w-4 shrink-0"
                  disabled={remoteControlReason !== undefined}
                  id={REMOTE_CONTROL_ID}
                  onChange={() => setDraft(current => ({ ...current, remoteControl: !current.remoteControl }))}
                  type="checkbox"
                />
                <span>Start with Remote Control on</span>
              </label>
              <p
                className="m-0 mt-1 text-meta leading-base text-muted"
                {...(remoteControlReason === undefined ? {} : { id: REMOTE_CONTROL_REASON_ID })}
              >
                {remoteControlReason ??
                  'Lets claude.ai/code and the Claude app drive this ferret. Off by default; Ferretry switches it off even if your Claude settings turn it on.'}
              </p>
            </div>
          </details>

          <FerretField hint="optional — groups related ferrets" inputId={fieldId('label')} label="Label">
            <input
              className="kt-input w-full"
              id={fieldId('label')}
              onChange={event => update('label', event.target.value)}
              placeholder="e.g. website-redesign"
              value={draft.label}
            />
          </FerretField>

          <FerretField
            hint={
              draft.mode === 'interactive' ? 'leave empty to start with a blank chat' : 'what you want the agent to do'
            }
            inputId={fieldId('prompt')}
            label={draft.mode === 'interactive' ? 'Opening message (optional)' : 'Opening prompt'}
          >
            <Textarea
              id={fieldId('prompt')}
              onChange={event => update('prompt', event.target.value)}
              placeholder={
                draft.mode === 'interactive' ? '(optional) first message…' : 'Describe what you want the agent to do…'
              }
              rows={6}
              value={draft.prompt}
            />
          </FerretField>

          {error ? (
            <div
              className="rounded-control border border-err-border bg-err-bg px-control-x py-row-y text-ui text-err"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-sm">
            {/* The reason sits beside the button it explains and is the button's description, so a screen reader hears
                why it is unavailable. A disabled primary still reads as a filled accent button at 55% opacity — which
                is how it looked pressable — so until it can be pressed it wears the outline look instead. */}
            {blocker === null ? null : (
              <p
                className="m-0 min-w-0 basis-full text-right text-meta leading-base text-muted sm:basis-0 sm:flex-1"
                id={CREATE_BLOCKER_ID}
              >
                {blocker}
              </p>
            )}
            <Button onClick={() => onNavigate(homePath)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button
              aria-describedby={blocker === null ? undefined : CREATE_BLOCKER_ID}
              disabled={!canSubmit}
              onClick={() => void submit()}
              type="button"
              variant={canSubmit || submitting ? 'primary' : 'outline'}
            >
              {submitting ? 'Creating…' : 'Create ferret'}
            </Button>
          </div>
        </PanelBody>
      </Card>
    </main>
  );
}

/**
 * The Runtime field's place when the picker found NO runtime that can run a ferret: one sentence and one way forward,
 * rather than an empty list. Runtimes are added in Settings › Runtimes. The picker draws this node; the page hears
 * `onShown` so Create can say why it is unavailable.
 */
function NoFerretAccounts({
  onOpenSettings,
  onShown,
}: {
  readonly onOpenSettings: () => void;
  /** Told while this notice is on screen. */
  readonly onShown: (shown: boolean) => void;
}) {
  useEffect(() => {
    onShown(true);
    return () => onShown(false);
  }, [onShown]);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-sm rounded-control border border-border-strong bg-surface-2 px-control-x py-row-y"
      data-new-ferret-no-accounts=""
    >
      <p className="m-0 min-w-[14rem] flex-1 text-ui leading-base text-fg-soft">
        No runtime on this machine can run ferrets yet. Add an agent runtime in Settings › Runtimes.
      </p>
      <Button onClick={onOpenSettings} type="button" variant="primary">
        Create a runtime
      </Button>
    </div>
  );
}

interface FerretFieldProps {
  readonly label: string;
  readonly hint: string;
  readonly inputId: string;
  /** Set when something other than the input names itself by this label (a radio group). */
  readonly labelId?: string;
  readonly children: ReactNode;
}

function FerretField({ label, hint, inputId, labelId, children }: FerretFieldProps) {
  return (
    <div className="block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <label className="text-ui font-semibold text-fg" htmlFor={inputId} id={labelId}>
          {label}
        </label>
        <span className="text-meta text-faint">{hint}</span>
      </span>
      {children}
    </div>
  );
}
