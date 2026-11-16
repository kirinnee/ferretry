/**
 * The browser entry for "the agenda line says the machine holds the owner's answers": the REAL `ferret-agenda-line`
 * panel over a scripted fake daemon (two open asks, three answers held for 45 s), drawn above a stand-in composer.
 *
 *   ?theme=<family>-<mode>
 */

import { RouterProvider } from '@ferretry/app/testing/router';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { createElement, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import app from '../../../../app/index.ts';
import manifest from '../../../../manifest.ts';
import { projectionSnapshot } from '../../../support/app/agenda-projection.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const FERRET = 'zoe';
const dueAt = new Date(Date.now() + 45_000).toISOString();

const client = {
  call: async (route: string) => {
    if (route === 'GET /v1/ferrets/:ferretId/agenda')
      return { ...projectionSnapshot(2, 0), sessionId: FERRET, replies: { pending: ['A1', 'A2'], dueAt } };
    if (route === 'GET /v1/ferrets/:ferretId/agenda-mode')
      return { enabled: true, restartRequired: false, note: 'Takes effect at the next launch.' };
    if (route === 'GET /v1/ferrets') return [];
    throw new Error(`no route ${route}`);
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

const half = app.build?.({ manifest, client });
const Panel = half?.panels['ferret-agenda-line'] as never;

function Scene() {
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
      <div style={{ padding: '0 12px' }}>
        {createElement(
          RouterProvider,
          null,
          createElement(Suspense, { fallback: null }, createElement(Panel, { subject: FERRET } satisfies PanelProps)),
        )}
        <div
          style={{
            margin: '8px 0 12px',
            padding: 12,
            border: '1px solid currentColor',
            borderRadius: 12,
            opacity: 0.6,
          }}
        >
          Reply to zoe…
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
