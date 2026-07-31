import { SessionDetails } from '../../src/components/session-details.tsx';
import { SessionList } from '../../src/components/session-list.tsx';
import { Transcript } from '../../src/components/transcript.tsx';
import { Composer } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import type { SessionView } from '@ferretry/protocol';
import { renderToStaticMarkup } from 'react-dom/server';

const session = {
  config: {
    id: 'same-session',
    name: 'Port session screens',
    label: 'Build the PWA session surfaces',
    teammate: 'Fable',
    modelHint: 'gpt-5.6',
    model: 'gpt-5.6-sol',
    agent: 'codex',
    mode: 'auto',
    cwd: '/work/ferretry',
    updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  },
  state: {
    id: 'same-session',
    status: 'running',
    turn: 8,
    lastActivityAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    contextPercent: 54,
    activity: 'Capturing both responsive views',
  },
  directory: '/work/ferretry',
} as unknown as SessionView;

const css = await Bun.file(new URL('../../src/components/session-screens.css', import.meta.url)).text();
const connection = daemonConnection({
  daemonId: 'paired-daemon',
  baseUrl: 'https://paired.example',
  deviceToken: 'preview-only',
});
const body = renderToStaticMarkup(
  <main className="preview">
    <SessionList daemonId="paired-daemon" onOpenSession={() => {}} sessions={[session]} />
    <div className="preview-conversation">
      <Transcript
        daemonId="paired-daemon"
        entries={[
          { id: 'u1', kind: 'user', label: 'You', text: 'Please port the session screens.' },
          { id: 'a1', kind: 'assistant', label: 'Fable', text: 'I have added the first tested surfaces.' },
          { id: 't1', kind: 'tool', label: 'Tool', text: 'Tests passed · typecheck passed' },
        ]}
        sessionId="same-session"
      />
      <Composer api={{ send: async () => ({}) as never }} daemon={connection} sessionId="same-session" />
    </div>
    <SessionDetails daemonId="paired-daemon" session={session} />
  </main>,
);
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
body{background:#f1f5f9;margin:0;padding:24px}.preview{display:grid;gap:20px;grid-template-columns:minmax(280px,1fr) minmax(320px,1.4fr) minmax(260px,.8fr);margin:auto;max-width:1400px}.preview-conversation{background:#fff;border:1px solid #d0d5dd;border-radius:12px;height:680px;min-height:0}@media(max-width:700px){body{padding:12px}.preview{display:grid;grid-template-columns:1fr}.preview-conversation{height:360px}}</style></head><body>${body}</body></html>`;

const server = Bun.serve({
  port: 0,
  fetch: () => new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
});
console.log(`http://127.0.0.1:${server.port}`);
