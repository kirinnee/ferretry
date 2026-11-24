import { SettingSwitch } from '@ferretry/app';
import { SetupNote, SetupSection } from '@ferretry/app/ui';
import { useId, useState } from 'react';
import type { StealthSwitch } from '../../../contract/index.ts';
import type { SaveOutcome } from './browser-mode-section.tsx';

/** The owner-facing note on site terms (docs/browser-mode.md, "Stealth"): said at the switch, not behind a link. */
export const STEALTH_TERMS_NOTE =
  'Hiding that a browser is automated, and solving captchas, can break a site’s terms of use. Whether to use it on a site is your call. Ferretry never signs in anywhere on its own beyond what you set up, and a bank can lock an account for unusual access.';

/** Said for as long as the file holds an `on` the owner has not confirmed (the switch still reads off, the value in effect). */
export const STEALTH_HELD_NOTE = 'Waiting for your confirmation: stealth stays off until you confirm turning it on.';

/**
 * "Stealth": the ONE switch for every identity on this machine. Nothing sits behind it yet, so turning it on changes no
 * behaviour. Off → on loosens `browsers.yaml`, so the daemon holds it for the owner; on → off applies at once.
 */
export function BrowserStealthSection({
  stealth,
  held,
  save,
}: {
  /** The switch in effect: a held `on` reads off. */
  readonly stealth: StealthSwitch;
  /** The saved file holds an `on` still waiting for the owner; read from the daemon, so it outlasts a re-read. */
  readonly held: boolean;
  readonly save: (next: StealthSwitch) => Promise<SaveOutcome>;
}) {
  const labelId = useId();
  const noteId = useId();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const flip = (on: boolean): void => {
    setBusy(true);
    setOutcome(null);
    void save(on ? 'on' : 'off').then(result => {
      setBusy(false);
      setOutcome(result);
    });
  };
  return (
    <SetupSection title="Stealth" name="browser-stealth" saves="now">
      <div className="flex max-w-xl min-w-0 items-center gap-2">
        <span id={labelId} className="min-w-0 flex-1 text-ui font-semibold text-fg">
          Let this machine’s browser pass bot checks
        </span>
        <SettingSwitch
          checked={stealth === 'on'}
          labelledBy={labelId}
          describedBy={noteId}
          disabled={busy}
          onChange={flip}
        />
      </div>
      <p id={noteId} className="m-0 max-w-xl text-meta leading-base text-muted" data-browser-stealth-note="">
        {STEALTH_TERMS_NOTE}
      </p>
      {held ? (
        <div className="max-w-xl">
          <SetupNote live tone="warn" name="browser-stealth-held">
            {STEALTH_HELD_NOTE}
          </SetupNote>
        </div>
      ) : null}
      {outcome?.kind === 'refused' ? (
        <div className="max-w-xl">
          <SetupNote live tone="warn" name="browser-stealth-refusal">
            {outcome.sentence}
          </SetupNote>
        </div>
      ) : null}
    </SetupSection>
  );
}
