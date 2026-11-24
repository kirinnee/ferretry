import { ChoiceCards, SettingFieldset, SettingSaveBar } from '@ferretry/app';
import { type ChangeAuthority, changeRefusalExplanation, InlineCode, SetupNote, SetupSection } from '@ferretry/app/ui';
import { useState } from 'react';
import type { BrowserMode } from '../../../contract/index.ts';

/** "Browser mode" (docs/browser-mode.md): each choice's words. */
const BROWSER_MODE_WORDS: Readonly<Record<BrowserMode, { readonly title: string; readonly detail: string }>> = {
  headless: {
    title: 'Headless',
    detail: 'No window. What agents use by default, and the only choice on a server with no screen.',
  },
  window: {
    title: 'Real window',
    detail:
      'A real Chrome window, for when you browse and sign in yourself: sites see an ordinary desktop browser. On Linux it draws on a private virtual screen (needs Xvfb); on a Mac it is a window on your desktop.',
  },
};

/** The sentence for a change the daemon holds until the owner confirms it (it loosens what this machine allows). */
export const HELD_CHANGE_SENTENCE = 'Saved, but not in effect until you confirm it.';

/** The name the tab is given when there is no machine to name (a suite): "This machine", "this machine" mid-sentence. */
export const UNNAMED_MACHINE = 'This machine';

/** A machine's name inside a sentence ("the browser on {it} starts"): the unnamed one reads in lower case. */
export const machineInSentence = (machineName: string): string =>
  machineName === UNNAMED_MACHINE ? 'this machine' : machineName;

/**
 * What saving a change answered: it took, the daemon holds it until the owner confirms it (the earlier setting stays in
 * effect), or one sentence on why it did not.
 */
export type SaveOutcome =
  | { readonly kind: 'saved' }
  | { readonly kind: 'pending'; readonly sentence: string }
  | { readonly kind: 'refused'; readonly sentence: string };

/** May a save be sent now? Not while the grant is being read, and not when it is refused (an unreadable one still tries). */
export const mayChange = (authority: ChangeAuthority | null): boolean =>
  authority !== null && authority.kind !== 'refused';

/**
 * What this browser may do with a save, said above the Save bar: the sentence that a passkey will be asked for, or the
 * grant guidance when it will not be allowed at all. Nothing while the owner's own save is open.
 */
export function ChangeAuthorityNote({
  machineName,
  authority,
}: {
  readonly machineName: string;
  readonly authority: ChangeAuthority | null;
}) {
  if (authority?.kind === 'refused')
    return (
      <p role="status" className="m-0 text-cell leading-base text-warn" data-change-grant-refused="">
        <InlineCode text={changeRefusalExplanation(authority.refusal)} />
      </p>
    );
  if (authority?.kind === 'step-up')
    return (
      <p className="m-0 text-meta leading-base text-muted" data-change-step-up="">
        {machineName} will ask you to confirm with your passkey when you save.
      </p>
    );
  return null;
}

export function BrowserModeSection({
  machineName,
  authority,
  mode,
  save,
}: {
  /** What this machine is called in the sentence that says it will ask for a passkey. */
  readonly machineName: string;
  /** What this browser may change here; `null` while it is being read. */
  readonly authority: ChangeAuthority | null;
  /** The saved mode. */
  readonly mode: BrowserMode;
  readonly save: (mode: BrowserMode) => Promise<SaveOutcome>;
}) {
  const [draft, setDraft] = useState<BrowserMode>(mode);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const pending = draft !== mode;
  const submit = (): void => {
    setBusy(true);
    void save(draft).then(result => {
      setBusy(false);
      setOutcome(result);
    });
  };
  return (
    <SetupSection title="Browser mode" name="browser-mode" saves="on-save">
      {/* Cards, staged: an arrow key moves the pick, and nothing is written until Save. */}
      <SettingFieldset saving={busy}>
        <ChoiceCards
          label="Browser mode"
          value={draft}
          onChange={value => {
            setDraft(value as BrowserMode);
            setOutcome(null);
          }}
          options={(['headless', 'window'] as const).map(choice => ({
            id: choice,
            title: BROWSER_MODE_WORDS[choice].title,
            line: BROWSER_MODE_WORDS[choice].detail,
          }))}
        />
      </SettingFieldset>
      <p className="m-0 text-meta leading-base text-muted" data-browser-mode-hint="">
        Applies the next time the browser on {machineInSentence(machineName)} starts. Neither mode solves a captcha for
        you: when a page asks, take it over and solve it yourself.
      </p>
      {outcome?.kind === 'refused' ? (
        <SetupNote live tone="warn" name="browser-mode-refusal">
          {outcome.sentence}
        </SetupNote>
      ) : null}
      {outcome?.kind === 'pending' ? (
        <SetupNote live tone="warn" name="browser-mode-held">
          {outcome.sentence}
        </SetupNote>
      ) : null}
      <ChangeAuthorityNote machineName={machineName} authority={authority} />
      {/* The ONE Save bar, as Security's: in flow while clean, sticky while a mode is staged; the same bar throughout. */}
      <SettingSaveBar
        dirty={pending}
        saving={busy}
        saved={outcome?.kind === 'saved' && !pending}
        blocked={!mayChange(authority)}
        saveLabel="Save browser mode"
        marks={{ 'data-browser-mode-save-panel': '' }}
        saveMarks={{ 'data-change-submit': '' }}
        onSave={submit}
        onDiscard={() => {
          setDraft(mode);
          setOutcome(null);
        }}
      />
    </SetupSection>
  );
}
