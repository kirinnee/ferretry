/** The Secure copy paste rules, holding rules whose route names a long URL, in a real browser fixture. */

import { createRoot } from 'react-dom/client';
import type { PasteRule } from '../../../../contract/routes/index.ts';
import { CopyRulesCard } from '../../../../app/features/secure-copy/copy-rules-card.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const rule = (id: string, from: PasteRule['from'], to: PasteRule['to']): PasteRule => ({
  id: id.repeat(32),
  from,
  to,
  remaining: 7,
  used: 1,
  createdAt: '2026-08-05T09:00:00.000Z',
  createdBy: { kind: 'host' },
});

const RULES: readonly PasteRule[] = [
  rule('a', { kind: 'command', program: 'vercel' }, { kind: 'terminal', program: 'gh' }),
  rule('b', { kind: 'browser', origin: 'https://dashboard.example.test' }, { kind: 'secret', name: 'VERCEL_TOKEN' }),
  rule(
    'c',
    { kind: 'clipboard', origin: 'https://registry.internal.example.test' },
    { kind: 'browser', origin: 'https://console.deploy-targets.example.test' },
  ),
];

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="p-4" style={{ maxWidth: 720 }}>
      <CopyRulesCard onAdd={() => true} onRemove={() => true} rules={RULES} />
    </div>,
  );
