import {
  Button,
  type ChangeAuthority,
  ChangeApplyPanel,
  RadioChoices,
  SetupNote,
  SetupSection,
} from '@ferretry/app/ui';
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

/**
 * What saving a change answered: it took, the daemon holds it until the owner confirms it (the earlier setting stays in
 * effect), or one sentence on why it did not.
 */
export type SaveOutcome =
  | { readonly kind: 'saved' }
  | { readonly kind: 'pending'; readonly sentence: string }
  | { readonly kind: 'refused'; readonly sentence: string };

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
    <SetupSection title="Browser mode" name="browser-mode">
      <RadioChoices
        legend="Browser mode"
        legendHidden
        name="browser-mode"
        value={draft}
        onChoose={value => {
          setDraft(value);
          setOutcome(null);
        }}
        options={(['headless', 'window'] as const).map(choice => ({ id: choice, ...BROWSER_MODE_WORDS[choice] }))}
      />
      <p className="m-0 text-meta leading-base text-muted" data-browser-mode-hint="">
        Applies the next time the browser on this machine starts. Neither mode solves a captcha for you: when a page
        asks, take it over and solve it yourself.
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
      {pending ? (
        <div data-browser-mode-save-panel="">
          <ChangeApplyPanel
            machineName={machineName}
            authority={authority}
            busy={busy}
            refusal={null}
            submitLabel="Save browser mode"
            onSubmit={submit}
          >
            <Button type="button" data-browser-mode-undo="" onClick={() => setDraft(mode)}>
              Keep {BROWSER_MODE_WORDS[mode].title}
            </Button>
          </ChangeApplyPanel>
        </div>
      ) : null}
    </SetupSection>
  );
}
