/**
 * The `ferret.toolbar` panel `ferret-agenda-mode`: the "Agenda mode" switch for one ferret (today's Actions-menu
 * entry), read and set through Agenda's own `GET|PATCH /v1/ferrets/:ferretId/agenda-mode`. The daemon decides who may
 * set it: the daemon's note ("takes effect at the next launch") and a refusal are said in the status line the actions draw
 * (`actions.host`).
 */

import type { PanelProps } from '@ferretry/kernel/manifest';
import { AgendaModeSwitch, useAgendaSessionActions } from '../features/agenda/agenda-session-actions.tsx';
import type { AgendaRuntime } from '../lib/agenda-runtime.ts';

export function createAgendaModePanel(runtime: AgendaRuntime) {
  return function AgendaModePanel({ subject }: PanelProps) {
    const actions = useAgendaSessionActions({ client: runtime.client });
    if (subject === undefined) return null;
    return (
      <>
        <AgendaModeSwitch actions={actions} canControl ferret={subject} />
        {actions.host}
      </>
    );
  };
}
