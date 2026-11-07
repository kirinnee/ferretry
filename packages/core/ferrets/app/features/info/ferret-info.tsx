/**
 * Info for one ferret, bound to the reads that own its facts. The ferret record is read when Info opens; the managed
 * worktrees and the ferret list (lineage) when Overview is shown; the relaunch dial when Runtime is. Every read goes
 * through the one client by route key (`info-wire.ts`), so this file never reaches a daemon and a test hands it
 * exactly the rows a reader sees.
 *
 * THE FRAME. A right-hand panel on a desktop, a half/full bottom sheet on a phone — the ⓘ in the header opens either.
 */

import { Info, X } from 'lucide-react';
import { type ReactNode, useCallback, useId } from 'react';
import { displayCallsign } from '../../lib/callsign.ts';
import type { FerretsClient } from '../../lib/client.ts';
import { BottomSheet, browserClipboardWriter, type ClipboardWriter, useLayoutMode } from '../../ui.ts';
import { newRestartRequestId, restartWithResume } from '../header/ferret-operations.ts';
import { useRestartRefusal } from '../header/restart-refusal.tsx';
import { InfoNote } from './info-parts.tsx';
import { InfoOverview } from './info-overview.tsx';
import { InfoPanel } from './info-panel.tsx';
import type { InfoRelaunchRead } from './info-relaunch.tsx';
import { InfoRuntime } from './info-runtime.tsx';
import { readFerret, readFerrets, readRelaunchSettings, readWorktrees } from './info-wire.ts';
import { type InfoRead, useInfoRead } from './use-info-read.ts';
import { useInfoPlacement } from './use-info-placement.ts';

interface FerretInfoProps {
  readonly client: FerretsClient;
  readonly ferretId: string;
  /** Phone: the sheet's half/full control is offered. */
  readonly presentation: 'panel' | 'sheet';
  readonly titleId: string;
  readonly placement: ReturnType<typeof useInfoPlacement>;
  readonly write: ClipboardWriter;
  readonly onRename?: () => void;
  readonly onOpenFerret?: (ferretId: string) => void;
  /** The model and effort pickers, when the host has them (another surface owns them). */
  readonly runtimeControls?: ReactNode;
  readonly now?: () => number;
}

const relaunchRead = (
  read: InfoRead<{ current: boolean; reasons: readonly ('arguments' | 'settings')[] }>,
): InfoRelaunchRead =>
  read.kind === 'ready'
    ? { kind: 'ready', settings: { current: read.value.current, reasons: [...read.value.reasons] } }
    : read.kind === 'failed'
      ? { kind: 'failed', reason: read.reason }
      : { kind: 'loading' };

function FerretInfo({
  client,
  ferretId,
  presentation,
  titleId,
  placement,
  write,
  onRename,
  onOpenFerret,
  runtimeControls,
  now = () => globalThis.Date.now(),
}: FerretInfoProps) {
  const { tab } = placement;
  const ferret = useInfoRead(() => readFerret(client, ferretId), true);
  const worktrees = useInfoRead(() => readWorktrees(client), tab === 'overview');
  const ferrets = useInfoRead(() => readFerrets(client), tab === 'overview');
  const relaunch = useInfoRead(() => readRelaunchSettings(client, ferretId), tab === 'runtime');
  const record = ferret.read.kind === 'ready' ? ferret.read.value : null;
  // The same Restart as Actions: a paused one (in-flight work, a smaller window, an unresumable conversation) is held
  // by the panel below with its deliberate "Restart anyway", and is never claimed as done.
  const refusal = useRestartRefusal(() => {
    ferret.reload();
    relaunch.reload();
  }, ferretId);
  const restart = useCallback(async (): Promise<boolean> => {
    if (record === null) return false;
    try {
      await restartWithResume(client, record, newRestartRequestId());
    } catch (reason) {
      if (refusal.capture(reason)) return false;
      throw reason;
    }
    ferret.reload();
    relaunch.reload();
    return true;
  }, [client, record, refusal.capture, ferret.reload, relaunch.reload]);

  if (record === null)
    return (
      <div className="fy-info" data-info-panel="">
        <div className="fy-info__head">
          <h2 className="fy-info__title" id={titleId}>
            Info
          </h2>
          <button
            aria-label="Close Info"
            className="fy-info__icon"
            data-info-close=""
            onClick={placement.close}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
        <div className="fy-info__body">
          <InfoNote>
            {ferret.read.kind === 'failed'
              ? `Couldn’t read this ferret: ${ferret.read.reason}`
              : 'Reading this ferret…'}
          </InfoNote>
        </div>
      </div>
    );

  const name = displayCallsign(record.name) || record.id;
  return (
    <InfoPanel
      name={name}
      onClose={placement.close}
      onTabChange={placement.setTab}
      tab={tab}
      titleId={titleId}
      {...(presentation === 'sheet'
        ? { sheetSize: placement.sheetSize, onSheetSizeChange: placement.setSheetSize }
        : {})}
      render={{
        overview: () => (
          <>
            <InfoOverview
              about={{ onRestart: restart }}
              ferret={record}
              name={name}
              now={now()}
              worktrees={worktrees.read.kind === 'ready' ? worktrees.read.value : null}
              write={write}
              {...(ferrets.read.kind === 'ready' ? { ferrets: ferrets.read.value } : {})}
              {...(onRename === undefined ? {} : { onRename })}
              {...(onOpenFerret === undefined ? {} : { onOpenFerret })}
            />
            {refusal.panel}
          </>
        ),
        runtime: () => (
          <>
            <InfoRuntime
              ferret={record}
              relaunch={relaunchRead(relaunch.read)}
              onRestart={restart}
              {...(runtimeControls === undefined ? {} : { controls: runtimeControls })}
            />
            {refusal.panel}
          </>
        ),
      }}
    />
  );
}

export interface InfoToggleProps extends Omit<FerretInfoProps, 'presentation' | 'titleId' | 'placement' | 'write'> {
  /** Open on this tab from the start (a deep link). */
  readonly initial?: 'overview' | 'runtime';
  readonly write?: ClipboardWriter;
}

/** The header's ⓘ and, while open, the frame Info draws in: a right panel on a desktop, a sheet on a phone. */
export function InfoToggle({ initial, write, ...rest }: InfoToggleProps) {
  const placement = useInfoPlacement(initial);
  const mode = useLayoutMode();
  const sheet = mode === 'drawer';
  const titleId = useId();
  const sheetId = `fy-info-sheet-${useId().replace(/:/gu, '')}`;
  const body = (
    <FerretInfo
      {...rest}
      placement={placement}
      presentation={sheet ? 'sheet' : 'panel'}
      titleId={titleId}
      write={write ?? browserClipboardWriter()}
    />
  );
  return (
    <>
      <button
        aria-label="Info"
        aria-pressed={placement.open}
        className="fy-session-bar__info fy-session-bar__icon"
        data-info-toggle=""
        onClick={placement.toggle}
        title="Info"
        type="button"
      >
        <Info aria-hidden="true" size={18} />
      </button>
      {!placement.open ? null : sheet ? (
        <BottomSheet
          ariaLabel="Info"
          closeLabel="Close Info"
          height={placement.sheetSize === 'full' ? '100%' : '60%'}
          id={sheetId}
          labelledBy={titleId}
          onClose={placement.close}
          open
        >
          {body}
        </BottomSheet>
      ) : (
        <aside aria-labelledby={titleId} className="fy-info-frame" data-info-frame="">
          {body}
        </aside>
      )}
    </>
  );
}
