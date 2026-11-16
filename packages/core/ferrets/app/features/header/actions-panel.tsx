/**
 * `ferret.toolbar` › `actions` — the header's one place for doing things to a ferret: the Actions ▾ menu, a Resume
 * button for a ferret that can come back, the toast a settled form leaves, and the paused-restart panel.
 *
 * It owns every Ferrets act on the header (stop, resume, rename, restart, pin, move), each through the half's own client
 * by route key (built once, in {@link useFerretActions}, which a list row's menu shares). WHO MAY DO THEM is the
 * daemon's: an owner act, or a governed device's, and a 403 or a step-up reaches the screen as the alert line below.
 */

import { PanelSlot } from '@ferretry/app';
import { ACTIONS_ROW_SLOT, type ActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import { Play } from 'lucide-react';
import { useState } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
import type { LiveFerretsClient } from '../../lib/client.ts';
import { useFerret } from '../../lib/ferret-read.ts';
import { cn, useLayoutMode } from '../../ui.ts';
import { ActionToast } from './action-toast.tsx';
import { ActionsMenu } from './actions-menu.tsx';
import type { CoreActionContext } from './core-actions.ts';
import type { FerretActionContribution } from './registry.ts';
import { reviveOffer } from './revive-offer.ts';
import { useFerretActions } from './use-ferret-actions.tsx';

export interface ActionsPanelProps {
  readonly client: LiveFerretsClient;
  /** The ferret the panel sits beside. */
  readonly subject: string | undefined;
  /** What this connection may change. Always yes today, as in today's PWA, which never computed it: the daemon refuses an act this device may not do. */
  readonly canControl?: boolean;
  /** More actions, from features that add them (same shape as the core ones). */
  readonly contributions?: readonly FerretActionContribution<CoreActionContext>[];
}

export function ActionsPanel({ client, subject, canControl = true, contributions = [] }: ActionsPanelProps) {
  const { read, reload } = useFerret(client, subject);
  if (read.kind !== 'ready' || subject === undefined) return null;
  return (
    <ActionsBar
      canControl={canControl}
      client={client}
      contributions={contributions}
      ferret={read.ferret}
      reload={reload}
    />
  );
}

function ActionsBar({
  client,
  ferret,
  reload,
  canControl,
  contributions,
}: {
  readonly client: LiveFerretsClient;
  readonly ferret: FerretSummary;
  readonly reload: () => Promise<unknown>;
  readonly canControl: boolean;
  readonly contributions: readonly FerretActionContribution<CoreActionContext>[];
}) {
  const compact = useLayoutMode() === 'drawer';
  const [form, setForm] = useState<string | null>(null);
  const actions = useFerretActions(client, ferret, reload, { canControl, contributions });
  const { context, daemon, name, alert, fail } = actions;
  const resumable = reviveOffer(ferret, canControl).offered;

  return (
    <div
      className={cn('fy-ferret-actions fy-ferret-bar')}
      data-compact={compact ? '' : undefined}
      data-ferret-actions=""
    >
      {resumable ? (
        <button
          aria-label={compact ? 'Resume' : undefined}
          className={cn(compact ? 'fy-ferret-bar__icon' : 'kt-btn kt-btn--sm')}
          data-ferret-resume=""
          onClick={() => {
            void context
              .resume()
              .catch((reason: unknown) =>
                fail(`Resume failed: ${reason instanceof Error ? reason.message : String(reason)}`),
              );
          }}
          title={reviveOffer(ferret, canControl).reason}
          type="button"
        >
          <Play aria-hidden="true" size={compact ? 18 : 14} />
          {compact ? null : <span>Resume</span>}
        </button>
      ) : null}
      {daemon === undefined ? null : (
        <PanelSlot
          daemon={daemon}
          props={{ ferret: ferret.id, name, canControl, offer: actions.offer } satisfies ActionsRowSlotProps}
          slot={ACTIONS_ROW_SLOT}
        />
      )}
      <ActionsMenu
        compact={compact}
        form={form}
        name={name}
        onFailure={fail}
        onFormChange={setForm}
        onNotice={actions.setNotice}
        sections={actions.sections}
      />
      {alert === null ? null : (
        <p className="fy-action-form__failure" data-ferret-alert="" role="alert">
          {alert.sentence}
          {alert.detail === undefined ? null : (
            <details>
              <summary>Details</summary>
              <pre>{alert.detail}</pre>
            </details>
          )}
        </p>
      )}
      {actions.panel}
      <ActionToast notice={actions.notice} onDismiss={() => actions.setNotice(null)} />
    </div>
  );
}
