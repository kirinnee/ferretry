/**
 * The browser entry for "the runtime picker in the composer's row": the REAL `RuntimePicker` panel beside the composer's
 * own row classes (`.fy-composer`, `.fy-composer-row`, `.fy-composer-input-layer`, `.fy-composer-send`: the stylesheet
 * that ships), in the chat page's column structure inside the `main` that clips its overflow. The daemon is a fake that
 * answers one ferret and (unless `?discovery=0`) its model catalog. Fake data only; no network.
 *
 *   ?compact=1       the phone's composer layout
 *   ?discovery=0     a daemon whose runtime discovery is not connected (the catalog read fails)
 *   ?theme=<family>-<mode>
 *
 * `window.__asked` is every route the picker called, in order.
 */
import type { PanelProps } from '@ferretry/kernel/manifest';
import { type FunctionComponent, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import type { RuntimesClient } from '../../../../app/lib/client.ts';
import { createRuntimePicker } from '../../../../app/views/runtime-picker.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const compact = params.get('compact') === '1';
const discovery = params.get('discovery') !== '0';

const FERRET = 'mvzoe001-5e7d0b1e';
const asked: string[] = [];
(window as unknown as { __asked: string[] }).__asked = asked;

const CATALOG = {
  harness: 'claude-code',
  source: 'wrapper-inventory',
  choices: [
    {
      value: 'claude-opus-5-5',
      label: 'Opus 5.5',
      description: 'The most capable',
      isDefault: true,
      reasoningEfforts: [],
    },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Fast and balanced', reasoningEfforts: [] },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5', description: 'Quick and light', reasoningEfforts: [] },
  ],
};

const client = {
  call: async (route: string) => {
    asked.push(route);
    if (route === 'GET /v1/ferrets/:ferretId')
      return {
        id: FERRET,
        name: 'zoe',
        role: 'lead',
        harness: 'claude-code',
        runner: 'tmux',
        folder: '/work/project',
        state: 'idle',
        model: 'claude-sonnet-5-5',
        createdAt: '2026-11-01T00:00:00.000Z',
        stateAt: '2026-11-01T00:00:00.000Z',
      };
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
              {compact ? (
                <div className="fy-composer-dock" data-composer-dock="start">
                  {tools}
                </div>
              ) : (
                tools
              )}
              <div className="fy-composer-input-layer">
                <textarea aria-label="Message" placeholder="Message this ferret" rows={1} />
              </div>
              <div className="fy-composer-dock" data-composer-dock="">
                <button aria-label="Send" className="fy-composer-send" data-composer-send="" type="submit">
                  ↑
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  </main>,
);
