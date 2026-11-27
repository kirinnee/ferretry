/** The real Inbox, ask screen and chat-line panel. Only the shell and daemon are synthetic. */
import { type AgendaItem, type AgendaSnapshot, MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import { RouterProvider } from '@ferretry/app/testing/router';
import { ScreenHrefProvider, useRouter } from '@ferretry/app';
import type { PanelProps, PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import type { ComponentType } from 'react';
import { createSurfaces } from '../../../app/views/surfaces.tsx';
import { answerReceipts } from '../../../app/lib/answer-receipts.ts';
import manifest from '../../../manifest.ts';
import { agendaItem, choices } from './agenda-inbox.tsx';

export const pendingAnswerRoutes = () => {
  const now = new Date().toISOString();
  let items: AgendaItem[] = [
    agendaItem('A2', {
      title: 'Ship the relay fix',
      subject: 'Ship the relay fix today?',
      ask: choices('Ship', 'Hold'),
      waitingSince: now,
    }),
    agendaItem('A3', {
      subject: 'Check the release notes?',
      ask: choices('Check', 'Later'),
      waitingSince: '2026-01-01T00:00:00.000Z',
    }),
  ];
  const commits: { resolve: () => void; reject: (reason: Error) => void }[] = [];
  const snapshot = (sessionId = 'sess-1'): AgendaSnapshot => ({
    v: 1,
    sessionId,
    items: sessionId === MACHINE_AGENDA_ID ? [] : items,
    resolved: [],
    count: sessionId === MACHINE_AGENDA_ID ? 0 : items.length,
    parseErrors: 0,
    updatedAt: now,
  });
  const client = {
    call: async (
      route: string,
      init?: { params?: Record<string, string>; body?: { id?: string; response?: unknown } },
    ) => {
      if (route === 'GET /v1/ferrets')
        return [{ id: 'sess-1', name: 'zoe', title: 'Relay fix', state: 'working', mode: 'auto' }];
      if (route === 'GET /v1/agenda/open') return { sessions: [{ sessionId: 'sess-1', items }] };
      if (route === 'GET /v1/machine/agenda') return snapshot(MACHINE_AGENDA_ID);
      if (route === 'GET /v1/ferrets/:ferretId/agenda') return snapshot();
      if (route === 'GET /v1/ferrets/:ferretId/agenda-mode')
        return { enabled: true, restartRequired: false, note: 'Takes effect at next launch.' };
      if (route === 'POST /v1/ferrets/:ferretId/agenda') {
        await new Promise<void>((resolve, reject) => commits.push({ resolve, reject }));
        items = items.map(item =>
          item.id !== init?.body?.id
            ? item
            : ({
                ...item,
                ownerAnswer: { at: now, response: init?.body?.response, request: 1 },
                conversation: [{ at: now, by: 'owner', text: 'Ship', via: 'answer' }],
                conversationCount: 1,
              } as AgendaItem),
        );
        return snapshot();
      }
      if (route.endsWith('/conversation')) return { total: 0, index: 0, offset: 0 };
      if (route.endsWith('/messages')) return { v: 1, ferret: 'sess-1', messages: [], nextCursor: null };
      if (route.endsWith('/sends')) return { sends: [] };
      if (route.endsWith('/versions')) return { sessionId: 'sess-1', id: init?.params?.id, latest: 0, versions: [] };
      if (route.endsWith('/:id')) return { item: items.find(item => item.id === init?.params?.id) };
      if (route === 'POST /v1/push/seen') return {};
      throw new Error(`No synthetic route ${route}`);
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  const surfaces = createSurfaces(client);
  const Inbox = surfaces.screens.agenda as ComponentType<ScreenProps>;
  const Ask = surfaces.screens['agenda-ask'] as ComponentType<ScreenProps>;
  const Line = surfaces.panels['ferret-agenda-line'] as ComponentType<PanelProps>;
  let go: (to: string) => void = () => undefined;
  function Routed() {
    const router = useRouter();
    go = router.navigate;
    const route = router.route;
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', padding: 12 }}>
        {route.kind === 'screen' && route.screen.id === 'agenda-ask' ? (
          <Ask params={route.params} />
        ) : route.kind === 'screen' && route.screen.id === 'agenda' ? (
          <Inbox params={route.params} />
        ) : (
          <div className="kt-chat-surface">
            <Line subject="sess-1" />
          </div>
        )}
      </div>
    );
  }
  function Scene() {
    return (
      <RouterProvider
        screens={(manifest.ui?.screens ?? []).map(screen => ({ ...screen, plugin: 'agenda', label: screen.id }))}
      >
        <ScreenHrefProvider
          href={(daemon, plugin, screen, params) =>
            plugin === 'agenda'
              ? `/d/${daemon}/agenda`
              : plugin === 'conversation' && screen === 'chat'
                ? `/d/${daemon}/session/${params?.ferret ?? ''}`
                : undefined
          }
        >
          <Routed />
        </ScreenHrefProvider>
      </RouterProvider>
    );
  }
  return { Scene, commits, go: (to: string) => go(to), state: answerReceipts.getSnapshot };
};
