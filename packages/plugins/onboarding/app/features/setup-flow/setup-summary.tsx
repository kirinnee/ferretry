/**
 * THE CLOSE OF THE SETUP, once no step waits for an answer: what was set up (on the machine, and on this device) as one
 * row each with a mark, what was skipped as a short list with a button to its Settings so nothing left undone is lost, and
 * where to change the rest. It names plugins ("Claude Code") and device pages ("Passkey"), never the pages inside a
 * plugin. Every button here is the frame's own 8.5rem wide (never the row wide), in one column on the right of its row.
 */
import { DEVICE_SETTINGS_HREF, daemonSettingsHref } from '@ferretry/app';
import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { RouterLink, type SummaryStep } from '../../views/steps-screen.tsx';
import './end-page.css';

/** The plugin whose setup page names the machine itself. */
const MACHINE_PLUGIN = 'onboarding';

interface SummaryGroup {
  /** The Settings tab that holds it. */
  readonly plugin: string;
  readonly name: string;
  readonly phase: 'daemon' | 'client';
  readonly set: number;
  readonly left: number;
}

/**
 * One entry per plugin on the machine (in the order the flow met them) and one per page of this device (a device page
 * is named by its own title): how many of its pages were set up and how many were not.
 */
const groupsOf = (steps: readonly SummaryStep[]): readonly SummaryGroup[] => {
  const groups = new Map<string, SummaryGroup>();
  for (const step of steps) {
    const phase = step.phase ?? 'daemon';
    const id = phase === 'client' ? `client:${step.plugin}.${step.id}` : `daemon:${step.plugin}`;
    const before = groups.get(id) ?? {
      plugin: step.plugin,
      name: phase === 'client' ? step.title : step.group,
      phase,
      set: 0,
      left: 0,
    };
    const wasSet = step.state === 'done' || step.state === 'found';
    groups.set(id, { ...before, set: before.set + (wasSet ? 1 : 0), left: before.left + (wasSet ? 0 : 1) });
  }
  return [...groups.values()];
};

/** One row of the card: a mark, a label, and what belongs to it. */
function Row({
  id,
  mark = 'done',
  label,
  children,
}: {
  readonly id: string;
  readonly mark?: 'done' | 'none';
  readonly label: string;
  readonly children?: ReactNode;
}): ReactNode {
  const Mark = mark === 'done' ? Check : Minus;
  return (
    <div className="fy-end__row" data-end-row={id}>
      <span className="fy-end__mark" data-mark={mark} aria-hidden="true">
        <Mark size={16} strokeWidth={2.5} />
      </span>
      <div className="fy-end__what">
        <p className="fy-end__label">{label}</p>
        {children}
      </div>
    </div>
  );
}

const Names = ({ names }: { readonly names: readonly string[] }): ReactNode => (
  <ul className="fy-end__names">
    {names.map(name => (
      <li key={name}>{name}</li>
    ))}
  </ul>
);

export function SetupSummary({
  daemon,
  steps,
}: {
  readonly daemon: string;
  readonly steps: readonly SummaryStep[];
}): ReactNode {
  if (steps.length === 0 || steps.some(step => step.state === 'pending')) return null;
  const groups = groupsOf(steps);
  const left = groups.filter(group => group.left > 0);
  const named = (phase: SummaryGroup['phase']): readonly string[] => {
    const set = groups.filter(group => group.phase === phase && group.set > 0);
    // The machine's own page (its name) is not a thing to list: the row is about what was brought in.
    const listed =
      phase === 'daemon' && set.some(group => group.plugin !== MACHINE_PLUGIN)
        ? set.filter(group => group.plugin !== MACHINE_PLUGIN)
        : set;
    return listed.map(group => group.name);
  };
  const onMachine = named('daemon');
  const onDevice = named('client');
  const deviceOnly = onDevice.length > 0 && onMachine.length === 0;
  const settingsHref = deviceOnly ? DEVICE_SETTINGS_HREF : daemonSettingsHref(daemon);
  return (
    <section className="kt-panel fy-end__card" data-onboarding-summary="">
      <div className="fy-end__rows" data-onboarding-summary-set="">
        {onMachine.length === 0 ? null : (
          <Row id="machine" label="Set up on this machine">
            <Names names={onMachine} />
          </Row>
        )}
        {onDevice.length === 0 ? null : (
          <Row id="device" label="Set up on this device">
            <Names names={onDevice} />
          </Row>
        )}
        {onMachine.length + onDevice.length === 0 ? (
          <Row id="nothing" mark="none" label="Nothing was set up this time." />
        ) : null}
        {left.length === 0 ? <Row id="skipped" label="Nothing was skipped." /> : null}
      </div>
      {left.length === 0 ? null : (
        <div className="fy-end__later" data-onboarding-summary-later="">
          <h2 className="fy-end__heading">Left for later</h2>
          <ul className="fy-end__list">
            {left.map(group => (
              <li key={`${group.phase}:${group.plugin}:${group.name}`} className="fy-end__item">
                <span className="fy-end__item-name">
                  {group.name}
                  {group.set > 0 ? <span className="fy-end__item-note">Some pages skipped</span> : null}
                </span>
                <RouterLink
                  button
                  href={group.phase === 'client' ? DEVICE_SETTINGS_HREF : daemonSettingsHref(daemon, group.plugin)}
                  aria-label={`Finish ${group.name}`}
                  data-onboarding-later-link={group.plugin}
                >
                  Finish
                </RouterLink>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="fy-end__item fy-end__where" data-onboarding-summary-where="">
        <span className="fy-end__item-name">Change any of this later in Settings.</span>
        <RouterLink button href={settingsHref} data-onboarding-open-settings="">
          Open Settings
        </RouterLink>
      </div>
    </section>
  );
}
