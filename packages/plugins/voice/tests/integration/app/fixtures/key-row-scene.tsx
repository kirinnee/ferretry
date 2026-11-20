/**
 * Voice's Jev key row (`SpeedupKeyRow`, the `speedup-key` panel's body) alone over a fake daemon, in a 420 px column like
 * the one a first-run page gives it. `?theme=<family>-<mode>`. The fake vault route and Test route record on `window.__fake`
 * the NAMES and lengths that reached them, never the key's text.
 */
import { createRoot } from 'react-dom/client';
import { SpeedupKeyRow } from '../../../../app/features/speedups/key-row.tsx';
import { daemonConnection } from '../../../../app/shell-voice.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const fake = { puts: [] as { name: string; length: number }[], tests: 0 };
(window as unknown as { __fake: typeof fake }).__fake = fake;
let stored = false;

const status = () => ({
  provider: 'jev',
  label: 'Jev',
  purpose: 'Triage.',
  costNote: 'Cheap.',
  privacyNote: 'A summary.',
  keyUrl: 'https://keys.example.test/',
  testNote: 'One decision.',
  secretName: 'JEV_API_KEY',
  set: stored,
  testStale: false,
});

const client = {
  request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
    if (path === '/v1/secrets') {
      const body = JSON.parse(String(init?.body)) as { name: string; value: string };
      fake.puts.push({ name: body.name, length: body.value.length });
      stored = true;
      return schema.parse({});
    }
    if (path.endsWith('/test')) {
      fake.tests += 1;
      return schema.parse({
        provider: 'jev',
        secretName: 'JEV_API_KEY',
        ok: true,
        code: 'ok',
        message: 'The key works.',
        latencyMs: 120,
        at: new Date().toISOString(),
      });
    }
    return schema.parse({ vault: 'ok', providers: [status()] });
  },
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main style={{ boxSizing: 'border-box', maxWidth: 420, padding: 16 }}>
      <SpeedupKeyRow
        connection={daemonConnection({ daemonId: 'a', baseUrl: 'https://a.example.test', deviceId: 'd' })}
        provider="jev"
        createClient={async () => client as never}
      />
    </main>,
  );
