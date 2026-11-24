/**
 * The browser entry for "the runtime picker on the composer's status line": the REAL `RuntimePicker` panel (model, thinking and
 * speed) on the status line under the composer's own row classes (`.fy-composer`, `.fy-composer-row`, `.fy-composer-actions`,
 * `.fy-composer-input-layer`, `.fy-composer-send`: the stylesheet that ships), in the chat page's column structure inside the
 * `main` that clips its overflow. The daemon is a fake that
 * answers one ferret and (unless `?discovery=0`) its model catalog. Fake data only; no network.
 *
 *   ?compact=1       the phone's composer layout
 *   ?discovery=0     a daemon whose runtime discovery is not connected (the catalog read fails)
 *   ?model=<id>      the model the ferret was LAUNCHED on (default: Opus 5.5; Sonnet and Haiku have no fast mode); `none` is an unpinned ferret
 *   ?observed=<id>   the model the harness REPORTED running (the summary's `observedModel`)
 *   ?theme=<family>-<mode>
 *
 * `window.__asked` is every route the picker called, in order.
 */
import type { PanelProps } from '@ferretry/kernel/manifest';
import { type FunctionComponent, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import type { RuntimesClient } from '../../../../app/lib/client.ts';
import { RuntimeCatalogSchema } from '../../../../contract/index.ts';
import { runtime } from '../../../unit/app/features/fleet/account-support.ts';
import { createRuntimePicker } from '../../../../app/views/runtime-picker.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const compact = params.get('compact') === '1';
const discovery = params.get('discovery') !== '0';
const launched = params.get('model') ?? 'claude-opus-5-5';
const model = launched === 'none' ? undefined : launched;
const observed = params.get('observed') ?? undefined;

const FERRET = 'mvzoe001-5e7d0b1e';
const asked: string[] = [];
(window as unknown as { __asked: string[] }).__asked = asked;

const CATALOG = {
  harness: 'claude',
  source: 'wrapper-inventory',
  choices: [
    {
      value: 'claude-opus-5-5',
      label: 'Opus 5.5',
      description: 'The most capable',
      isDefault: true,
      reasoningEfforts: [],
      fast: true,
    },
    {
      value: 'claude-sonnet-5-5',
      label: 'Sonnet 5.5',
      description: 'Fast and balanced',
      reasoningEfforts: [],
      fast: false,
    },
    {
      value: 'claude-haiku-5-5',
      label: 'Haiku 5.5',
      description: 'Quick and light',
      reasoningEfforts: [],
      fast: false,
    },
  ],
};

// The runtime the ferret runs on, so the popover can say "Runs on Claude · your terminal sign-in" instead of a stored name.
const ROSTER = RuntimeCatalogSchema.parse({
  format: 'present',
  runtimes: [runtime({ name: 'claude-you', credential: { id: 'claude-you', store: 'host', status: 'ready' } })],
});

const client = {
  call: async (route: string) => {
    asked.push(route);
    if (route === 'GET /v1/ferrets/:ferretId')
      return {
        id: FERRET,
        name: 'zoe',
        role: 'lead',
        harness: 'claude-code',
        runtime: 'claude-you',
        runner: 'tmux',
        folder: '/work/project',
        state: 'idle',
        ...(model === undefined ? {} : { model }),
        ...(observed === undefined ? {} : { observedModel: observed }),
        effort: 'high',
        createdAt: '2026-11-01T00:00:00.000Z',
        stateAt: '2026-11-01T00:00:00.000Z',
      };
    if (route === 'GET /v1/runtimes') return ROSTER;
    if (route === 'GET /v1/ferrets/:id/runtime-models') {
      if (discovery) return CATALOG;
      throw new Error('Runtime model discovery is not connected to Ferrets yet.');
    }
    return {};
  },
} as unknown as RuntimesClient;

const Picker = createRuntimePicker(client) as unknown as FunctionComponent<PanelProps>;
const tools = (
  <Suspense fallback={null}>
    <Picker subject={FERRET} {...({} as PanelProps)} />
  </Suspense>
);

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="flex h-full min-h-0 min-w-0 flex-col overflow-clip" style={{ position: 'fixed', inset: 0 }}>
    <header style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>Fixture running · zoe</header>
    <div className="kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col" data-chat-width="balanced">
      <div className="fy-chat-log">
        <div className="fy-chat-log__messages">
          <p style={{ padding: 16 }}>Fake conversation: the log fills what the composer leaves.</p>
        </div>
      </div>
      <div className="fy-chat-input" data-safe-bottom="">
        <div className="fy-chat-input__column">
          <form
            className="fy-composer"
            data-composer-layout={compact ? 'phone' : undefined}
            onSubmit={event => event.preventDefault()}
          >
            <div className="fy-composer-row">
              <button aria-label="Add to message" className="fy-composer-icon" type="button">
                +
              </button>
              <div className="fy-composer-input-layer">
                <textarea aria-label="Message" placeholder="Message this ferret" rows={1} />
              </div>
              <div className="fy-composer-dock" data-composer-dock="">
                <button aria-label="Send" className="fy-composer-send" data-composer-send="" type="submit">
                  ↑
                </button>
              </div>
            </div>
            <div className="fy-composer-actions" data-composer-status="">
              <span className="fy-composer-status-chrome">{tools}</span>
            </div>
          </form>
        </div>
      </div>
    </div>
  </main>,
);
