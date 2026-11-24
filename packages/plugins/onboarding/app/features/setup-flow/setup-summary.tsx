/**
 * THE CLOSE OF THE SETUP, once no step waits for an answer: what was set up as two borderless checklists, one for THIS
 * MACHINE and one for THIS DEVICE, with ONE row per segment (a plugin on the machine, a page of this device). A set-up
 * segment is a checked row; a segment left for later is a quiet row that says so, with a small link to its Settings so
 * nothing left undone is lost. It names plugins ("Claude Code") and device pages ("Passkey"), never the pages inside a
 * plugin. Nothing here is a box: no border, no card, only spacing (`end-page.css`).
 */
import { daemonSettingsHref, deviceSettingsHref } from '@ferretry/app';
import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { RouterLink, type SummaryStep } from '../../views/steps-screen.tsx';
import './end-page.css';

/** The plugin whose setup page names the machine itself. */
const MACHINE_PLUGIN = 'onboarding';

type Phase = 'daemon' | 'client';
/** done: every page set up · partial: some set up, some left · later: none set up. */
type SegmentState = 'done' | 'partial' | 'later';

interface Segment {
  /** `daemon:<plugin>` or `client:<plugin>.<page>`: one per segment. */
  readonly key: string;
  /** The page's id (a device page is its own segment). */
  readonly id: string;
  /** The Settings tab that holds it. */
  readonly plugin: string;
  readonly name: string;
  readonly phase: Phase;
  readonly state: SegmentState;
}

/**
 * One segment per plugin on the machine (in the order the flow met them) and one per page of this device (a device page
 * is named by its own title): how many of its pages were set up decides its state.
 */
const segmentsOf = (steps: readonly SummaryStep[]): readonly Segment[] => {
  const counts = new Map<
    string,
    { key: string; id: string; plugin: string; name: string; phase: Phase; set: number; left: number }
  >();
  for (const step of steps) {
    const phase: Phase = step.phase ?? 'daemon';
    const id = phase === 'client' ? `client:${step.plugin}.${step.id}` : `daemon:${step.plugin}`;
    const before = counts.get(id) ?? {
      key: id,
      id: step.id,
      plugin: step.plugin,
      name: phase === 'client' ? step.title : step.group,
      phase,
      set: 0,
      left: 0,
    };
    const wasSet = step.state === 'done' || step.state === 'found';
    counts.set(id, { ...before, set: before.set + (wasSet ? 1 : 0), left: before.left + (wasSet ? 0 : 1) });
  }
  return [...counts.values()].map(({ set, left, ...segment }) => ({
    ...segment,
    state: left === 0 ? 'done' : set === 0 ? 'later' : 'partial',
  }));
};

/**
 * The names of the segments NOT fully set up (a plugin left for later, a page of this device skipped), in the order the
 * flow met them. The last page's heading reads this: it says "You're set up" only when this is empty (S-54).
 */
export const leftToFinish = (steps: readonly SummaryStep[]): readonly string[] =>
  steps.some(step => step.state === 'pending')
    ? []
    : segmentsOf(steps)
        .filter(segment => segment.state !== 'done')
        .map(segment => segment.name);

/** Where a page left for later is finished: the page's own place when it has one (Connect GitHub is the GitHub accounts tab), else this device's settings. */
const GITHUB_ACCOUNTS_PAGE = 'projects.github';
const finishHref = (daemon: string, segment: Segment): string =>
  segment.phase === 'daemon'
    ? daemonSettingsHref(daemon, segment.plugin)
    : `${segment.plugin}.${segment.id}` === GITHUB_ACCOUNTS_PAGE
      ? daemonSettingsHref(daemon, 'git-accounts', 'accounts')
      : deviceSettingsHref(daemon);

/** What a row that is not fully set up says, quietly, under its name. */
const NOTE: Record<Exclude<SegmentState, 'done'>, string> = { later: 'Finish later', partial: 'Partly set up' };

function Row({ daemon, segment }: { readonly daemon: string; readonly segment: Segment }): ReactNode {
  const done = segment.state === 'done';
  const Mark = done ? Check : Minus;
  return (
    <li className="fy-end__row" data-end-row={segment.key} data-end-state={segment.state}>
      <span className="fy-end__mark" data-mark={done ? 'done' : 'none'} aria-hidden="true">
        <Mark size={14} strokeWidth={3} />
      </span>
      <span className="fy-end__name">
        {segment.name}
        {done ? null : <span className="fy-end__note">{NOTE[segment.state]}</span>}
      </span>
      {done ? null : (
        <RouterLink
          href={finishHref(daemon, segment)}
          aria-label={`Finish ${segment.name}`}
          data-onboarding-later-link={segment.plugin}
        >
          {segment.state === 'later' ? 'Set up' : 'Finish'}
        </RouterLink>
      )}
    </li>
  );
}

function Checklist({
  daemon,
  which,
  title,
  segments,
}: {
  readonly daemon: string;
  readonly which: 'machine' | 'device';
  readonly title: string;
  readonly segments: readonly Segment[];
}): ReactNode {
  if (segments.length === 0) return null;
  return (
    <section className="fy-end__list" data-end-list={which} aria-label={title}>
      <h2 className="fy-end__heading">{title}</h2>
      <ul className="fy-end__rows">
        {segments.map(segment => (
          <Row key={segment.key} daemon={daemon} segment={segment} />
        ))}
      </ul>
    </section>
  );
}

export function SetupSummary({
  daemon,
  steps,
}: {
  readonly daemon: string;
  readonly steps: readonly SummaryStep[];
}): ReactNode {
  if (steps.length === 0 || steps.some(step => step.state === 'pending')) return null;
  const all = segmentsOf(steps);
  const of = (phase: Phase): readonly Segment[] => {
    const mine = all.filter(segment => segment.phase === phase);
    // The machine's own page (its name) is not a thing to list while anything else was brought in or left.
    return phase === 'daemon' && mine.length > 1
      ? mine.filter(segment => segment.plugin !== MACHINE_PLUGIN || segment.state !== 'done')
      : mine;
  };
  const onMachine = of('daemon');
  const onDevice = of('client');
  const deviceOnly = onDevice.length > 0 && onMachine.length === 0;
  return (
    <div className="fy-end__summary" data-onboarding-summary="" data-onboarding-summary-set="">
      <div className="fy-end__lists" data-lists={onMachine.length > 0 && onDevice.length > 0 ? 'two' : 'one'}>
        <Checklist daemon={daemon} which="machine" title="This machine" segments={onMachine} />
        <Checklist daemon={daemon} which="device" title="This device" segments={onDevice} />
      </div>
      <p className="fy-end__where" data-onboarding-summary-where="">
        <RouterLink
          href={deviceOnly ? deviceSettingsHref(daemon) : daemonSettingsHref(daemon)}
          data-onboarding-open-settings=""
        >
          Change any of this later in Settings
        </RouterLink>
      </p>
    </div>
  );
}
