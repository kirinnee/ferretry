/**
 * The browser entry for "the model picker shows the login's live list" (U6b), over the REAL `ModelSelect`:
 *
 *   ?state=fresh|stale   the list was read 2 hours ago / 3 days ago (the provider could not be asked again)
 *   &refresh=1|0         "Refresh list" is offered (a device that may configure) / not (a limited device)
 *   &theme=<family>-<mode>
 *
 * The ids are the DeepSeek catalog's two models and the ids DeepSeek's `/models` lists today (models.dev snapshot),
 * so the picker shows one curated model the list lacks and two models the catalog has not reviewed.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModelSelect } from '@ferretry/app/ui';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const stale = params.get('state') === 'stale';
const canRefresh = params.get('refresh') !== '0';

const NOW = Date.now();
const MODELS = [
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'best', context: 1_000_000, available: true, efforts: [] },
  { id: 'deepseek-flash', label: 'DeepSeek Flash', tier: 'fast', context: 1_000_000, available: true, efforts: [] },
] as const;

function Scene() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 8, margin: '0 auto', maxWidth: 560, padding: 16 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>New ferret</h1>
      <label htmlFor="model-field" style={{ fontWeight: 600 }}>
        Model override
      </label>
      <ModelSelect
        customIds
        defaultModel="deepseek-v4-pro"
        id="model-field"
        live={{
          list: {
            fetchedAt: new Date(NOW - (stale ? 3 * 86_400_000 : 2 * 3_600_000)).toISOString(),
            complete: true,
            ids: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
          },
          now: NOW,
          providerLabel: 'DeepSeek',
          ...(canRefresh
            ? {
                refresh: {
                  busy,
                  run: () => {
                    setBusy(true);
                    setTimeout(() => setBusy(false), 600);
                  },
                },
              }
            : {}),
        }}
        models={MODELS}
        onChange={setValue}
        value={value}
      />
      <p data-chosen style={{ margin: 0 }}>
        model: {value === '' ? '(login default)' : value}
      </p>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<Scene />);
