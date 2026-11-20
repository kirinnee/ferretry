/**
 * THE CAPABILITY LIST: what this browser may do on this machine, why, and how much it hands over.
 *
 * A companion to `grants-settings.tsx` rather than a replacement. That surface is for CHANGING the
 * operator's answers; this one is for READING them, and it answers two questions the switches cannot:
 *
 *  1. **Why is this open?** "Open because the operator granted it" and "open after your passkey" are
 *     different facts with different consequences, and a screen that renders both as a green tick
 *     teaches somebody that nothing here ever asks anything of them. It does.
 *  2. **How much does it hand over?** Five rows that look alike make `filesystem` and `fleet` weigh the
 *     same. One reads files; the other writes executables into accounts.
 *
 * ## THERE IS NO "DIRECT LOCAL" POSTURE, AND NOTHING MAY BRING ONE BACK
 *
 * A browser is a paired device wherever it runs, so a page on `http://127.0.0.1` is governed exactly like
 * a phone: only the host's admin token over loopback — the CLI — is the owner at the machine. The posture
 * arrives as a value the DAEMON derived from the carrier; this component reads no hostname, no
 * `location`, and no `baseUrl`, and there is deliberately no code path here that could.
 * `tests/…/capability-list.test.tsx` renders this screen on a `127.0.0.1` page and asserts it never
 * claims the limits do not apply — that test is the point of the file.
 *
 * ## A SIXTH CAPABILITY NEEDS NO CODE HERE
 *
 * Every row is generated from `CAPABILITY_NAMES`, so a new capability appears with its label, reach
 * line, weight and marks as soon as the protocol declares it and the vocabulary gives it prose. If
 * adding a capability ever needs layout code in this file, the design has gone wrong.
 */

import { CAPABILITY_AXES, CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import type { CapabilityAxis } from '@ferretry/kernel/contract';
import { SettingGroup, SettingRow } from '@ferretry/app';
import { InlineCode } from '@ferretry/app/ui';
import { CircleHelp, Wifi } from 'lucide-react';

import type { CapabilityGrantView } from '../../../contract/index.ts';
import { cn, type DaemonConnection } from '../../shell-grants.ts';
import {
  type AccessWeight,
  accessWeightsPresent,
  axisLabel,
  CAPABILITY_LIST_SCOPE_NOTE,
  type ConnectionPosture,
  capabilityLabel,
  capabilityReach,
  capabilityWeight,
  connectionPosture,
  deviceGrantNote,
  grantOnlyAtMachine,
  mayGrantCapability,
  type OpenReason,
  openReason,
  openReasonLabel,
  postureCopy,
  REMOTE_ONE_WAY_NOTE,
  weightCopy,
  weightPips,
} from '../../lib/grants.ts';
import { AccessTab, Notice, type NoticeTone } from './access-kit.tsx';

/** Posture tone (the vocabulary's words) to the one shared notice tone. */
const POSTURE_NOTICE: Readonly<Record<ReturnType<typeof postureCopy>['tone'], NoticeTone>> = {
  ok: 'ok',
  disclosure: 'info',
  limit: 'warn',
  fault: 'err',
};

/** Colour AND shape per reason, so the mark survives a monochrome render. */
const REASON_TONE: Readonly<Record<OpenReason, string>> = {
  granted: 'border-accent bg-accent-soft text-accent',
  'step-up': 'border-warn-border bg-warn-bg text-warn',
  closed: 'border-border-strong bg-surface text-muted',
  unknown: 'border-err-border bg-err-bg text-err',
};

/**
 * The access-weight mark: filled pips out of three, with the label beside it.
 *
 * NOT COLOUR ALONE. Three-of-three is legible without hue — to a colourblind reader, on a monochrome
 * print, and in a screenshot pasted into an issue — and this is the one mark on the page that tells
 * somebody how much of their machine a switch hands over.
 */
export function WeightMark({ weight }: { readonly weight: AccessWeight }) {
  const filled = weightPips(weight);
  const copy = weightCopy(weight);
  return (
    // `role="img"` because the pips ARE a graphic and a bare span supports no accessible name — the
    // label was being dropped on the floor for exactly the readers who cannot use the colour. Same
    // treatment the git marker in `files-views.tsx` already gets.
    <span
      role="img"
      className="inline-flex shrink-0 items-center gap-1.5"
      data-capability-weight={weight}
      title={copy.detail}
      aria-label={`${copy.label}: ${copy.detail}`}
    >
      <span aria-hidden="true" className="inline-flex items-center gap-0.5">
        {[0, 1, 2].map(index => (
          <span
            key={index}
            className={cn(
              'h-2 w-2 rounded-sm border',
              index < filled
                ? weight === 'broad'
                  ? 'border-err-border bg-err'
                  : weight === 'moderate'
                    ? 'border-warn-border bg-warn'
                    : 'border-ok-border bg-ok'
                : 'border-border-strong bg-transparent',
            )}
          />
        ))}
      </span>
      <span
        className={cn(
          'text-meta font-semibold',
          weight === 'broad' ? 'text-err' : weight === 'moderate' ? 'text-warn' : 'text-ok',
        )}
      >
        {copy.label}
      </span>
    </span>
  );
}

/**
 * The legend. A mark nobody can decode is decoration, so the key travels with the list.
 *
 * IT KEYS ONLY THE MARKS ON SCREEN. The weights come from the rows being rendered rather than from the
 * full set of classes, so a class no capability currently carries is not advertised — a "Reads only"
 * key with no read-only row below it reads as a claim about the machine that nothing supports.
 */
function WeightLegend({ weights }: { readonly weights: readonly AccessWeight[] }) {
  if (weights.length === 0) return null;
  return (
    <SettingRow name="How much each one hands over" hint="The marks on the rows below.">
      <ul className="fy-acc-legend" aria-label="What the access marks mean" data-capability-legend="">
        {weights.map(weight => (
          <li key={weight}>
            <WeightMark weight={weight} />
            <span className="text-meta text-muted">{weightCopy(weight).detail}</span>
          </li>
        ))}
      </ul>
    </SettingRow>
  );
}

function ReasonMark({
  entry,
  axis,
  posture,
}: {
  readonly entry: CapabilityGrantView;
  readonly axis: CapabilityAxis;
  readonly posture: ConnectionPosture;
}) {
  const reason = openReason(entry, axis, posture);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-meta font-semibold text-fg">{axisLabel(axis)}</span>
      <span
        className={cn('rounded-control border px-2 py-0.5 text-meta font-medium', REASON_TONE[reason])}
        data-capability-open-reason={`${entry.capability}.${axis}`}
        data-capability-reason={reason}
      >
        {openReasonLabel(reason)}
      </span>
    </span>
  );
}

function CapabilityRow({
  entry,
  posture,
}: {
  readonly entry: CapabilityGrantView;
  readonly posture: ConnectionPosture;
}) {
  const deviceNote = deviceGrantNote(entry);
  return (
    <SettingRow
      name={capabilityLabel(entry.capability)}
      hint={capabilityReach(entry.capability)}
      dataAttributes={{ 'data-capability-row': entry.capability }}
      control={() => <WeightMark weight={capabilityWeight(entry.capability)} />}
    >
      <div className="fy-acc-body">
        <span className="fy-acc-cap__axes">
          {CAPABILITY_AXES.map(axis => (
            <ReasonMark key={axis} entry={entry} axis={axis} posture={posture} />
          ))}
        </span>
        {deviceNote === null ? null : (
          <Notice tone="warn" marks={{ 'data-capability-device-note': entry.capability }}>
            {deviceNote}
          </Notice>
        )}
        {/* THE ONE-WAY DOOR, said where the switch would be. An off capability this caller may not turn
            on is not a control — it is a statement with a remedy, and the remedy is the machine itself.
            Rendering a toggle here would fail on press and teach somebody the product is broken rather
            than that the operator decided. `mayGrant` is the daemon's answer; nothing is inferred. */}
        {!entry.granted.use && !mayGrantCapability(entry) ? (
          <Notice tone="warn" marks={{ 'data-capability-only-at-machine': entry.capability }}>
            {grantOnlyAtMachine(entry.capability)}
          </Notice>
        ) : null}
      </div>
    </SettingRow>
  );
}

export interface CapabilityListProps {
  readonly connection: DaemonConnection;
  readonly capabilities: readonly CapabilityGrantView[];
  /**
   * Whether the operator's limits APPLY to this connection, as the daemon reported it.
   *
   * SUPPLIED from `GrantsView.governed` — the daemon's own `isGovernedCaller` answer and the only honest
   * source. Omitted, the posture reads "cannot tell" rather than guessing, and the limits are treated as
   * applying. Never derived from the page: a `127.0.0.1` address bar says nothing about the connection.
   */
  readonly governed?: boolean | undefined;
  /**
   * Draw the per-capability rows. The grants screen already draws each capability once, with its switches, so it asks
   * for the heading, the posture and the key only (`false`); everywhere else the rows are the point.
   */
  readonly rows?: boolean;
}

/**
 * The list. Render-only: it takes what the daemon said and shows it, and fetches nothing.
 *
 * A capability the view omits is simply absent — this screen never invents a row, so it can never show
 * an answer nobody gave. Rows are ordered by the protocol's own declaration rather than by arrival, so
 * a person can build a habit around their position.
 */
export function CapabilityList({ connection, capabilities, governed, rows = true }: CapabilityListProps) {
  const posture = connectionPosture(governed);
  const copy = postureCopy(posture);
  const entries = CAPABILITY_NAMES.map(capability =>
    capabilities.find(candidate => candidate.capability === capability),
  ).filter((entry): entry is CapabilityGrantView => entry !== undefined);
  const PostureIcon = posture === 'governed' ? Wifi : CircleHelp;

  return (
    <AccessTab name="capabilities">
      <div data-capability-list={String(connection.daemonId)} data-capability-posture={posture}>
        <SettingGroup label="What this browser may do here">
          {/* Scope, once and prominently: this browser on this daemon, not the machine's policy for every
              device that has ever paired with it. */}
          <SettingRow
            name="This connection"
            dataAttributes={{ 'data-capability-scope-note': '' }}
            control={() => (
              <span
                className="fy-acc-chip inline-flex items-center gap-1.5"
                data-tone={copy.tone === 'ok' ? 'ok' : copy.tone === 'fault' ? 'err' : 'plain'}
                data-capability-posture-badge={posture}
              >
                <PostureIcon size={13} aria-hidden="true" />
                {copy.badge}
              </span>
            )}
          >
            {/* WHY everything below reads the way it does — the distinction the switches cannot express. */}
            <div className="fy-acc-body" data-capability-posture-copy="">
              <p className="fy-acc-fine">{CAPABILITY_LIST_SCOPE_NOTE}</p>
              <Notice tone={POSTURE_NOTICE[copy.tone]}>
                <strong className="block">{copy.headline}</strong>
                {copy.detail}
              </Notice>
              {/* Which way the switches travel from HERE, stated rather than left to be discovered by pressing something. */}
              <p className="fy-acc-fine font-semibold" data-capability-direction={posture}>
                <InlineCode text={REMOTE_ONE_WAY_NOTE} />
              </p>
            </div>
          </SettingRow>
          <WeightLegend weights={accessWeightsPresent(entries.map(entry => entry.capability))} />
          {entries.length === 0 ? (
            <SettingRow name="Nothing to report" hint="This daemon listed no capabilities.">
              <div className="fy-acc-body" role="status">
                <p className="fy-acc-fine">
                  This daemon listed no capabilities, so there is nothing to report. That is a failed read rather than a
                  machine with no limits, and Ferretry will not present it as one.
                </p>
              </div>
            </SettingRow>
          ) : !rows ? null : (
            entries.map(entry => <CapabilityRow key={entry.capability} entry={entry} posture={posture} />)
          )}
        </SettingGroup>
      </div>
    </AccessTab>
  );
}
