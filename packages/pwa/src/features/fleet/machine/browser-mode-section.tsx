import type { BrowserMode, FleetMachineView } from '@ferretry/protocol';
import { useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import type { SetupAccess } from '../setup/setup-access.ts';
import { RadioChoices, SetupSection } from '../setup/setup-ui.tsx';
import { ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { machineSettings } from './machine-settings.ts';

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

export function BrowserModeSection({
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
  const current = machine.browserMode ?? 'headless';
  const [draft, setDraft] = useState<BrowserMode>(current);
  const pending = draft !== current;
  const save = (): void => {
    void changes.apply(machineSettings(machine, { browserMode: draft })).then(result => {
      if (result.kind === 'refused') return;
      onSaved();
    });
  };
  // A daemon that predates the setting runs headless and cannot be asked for anything else.
  if (machine.browserMode === undefined) return null;
  return (
    <SetupSection title="Browser mode" name="browser-mode">
      <RadioChoices
        legend="Browser mode"
        legendHidden
        name="browser-mode"
        value={draft}
        onChoose={value => {
          setDraft(value);
          changes.clear();
        }}
        options={(['headless', 'window'] as const).map(mode => ({ id: mode, ...BROWSER_MODE_WORDS[mode] }))}
      />
      <p className="m-0 text-meta leading-base text-muted" data-browser-mode-hint="">
        Applies the next time the browser on {machineName} starts. Neither mode solves a captcha for you: when a page
        asks, take it over and solve it yourself.
      </p>
      {pending ? (
        <ChangeApplyPanel
          machineName={machineName}
          authority={changes.authority}
          busy={changes.busy}
          refusal={changes.refusal}
          submitLabel="Save browser mode"
          onSubmit={save}
        >
          <Button type="button" data-browser-mode-undo="" onClick={() => setDraft(current)}>
            Keep {BROWSER_MODE_WORDS[current].title}
          </Button>
        </ChangeApplyPanel>
      ) : null}
    </SetupSection>
  );
}
