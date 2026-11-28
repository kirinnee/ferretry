/**
 * The browser entry for the move's shots: the REAL `MoveMachine` dialog over two SCRIPTED machines and FAKE data (no daemon, no key, no
 * real pairing code). The dialog drives the real `review` and `carry`; only the machines' answers are scripted.
 *
 *   ?theme=<family>-<mode>   ?style=<id>   ?hold=1 (a chunk never arrives: progress at rest)
 *   ?refuse=1 (the target says why it cannot take the ferret)
 */
import { ScreenHrefProvider, type DaemonReach } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { MoveMachine } from '../../../../app/features/move-machine.tsx';
import { MovedMark } from '../../../../app/features/moved-mark.tsx';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
root.dataset.theme = params.get('theme') ?? 'studio-light';
const style = params.get('style');
if (style !== null) root.dataset.style = style;
const hold = params.get('hold') === '1';
const refuse = params.get('refuse') === '1';
const recovery = params.get('recovery') === '1';
let completions = 0;
let release: (() => void) | undefined;
Object.assign(window, {
  finishMove: () => {
    if (release === undefined) return false;
    release();
    return true;
  },
});
document.body.style.fontFamily = 'DejaVu Sans';

const SOURCE = `fy_daemon_${'A'.repeat(43)}`;
const TARGET = `fy_daemon_${'B'.repeat(43)}`;
const OFFER = {
  v: 1,
  offerId: `fy_relocate_offer_${'o'.repeat(22)}`,
  daemonId: TARGET,
  identityKey: 'AAAA',
  publicKey: 'AAAA',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  signature: 'AAAA',
};
const NEEDS = {
  harness: 'claude-code',
  runtime: 'claude-default',
  remote: 'https://example.invalid/acme/project.git',
  secrets: [],
};
const MOVES = [
  { id: 'ferret-record', label: 'Its name, role, harness, runtime name, model and effort' },
  { id: 'turns', label: 'Every turn document it was given' },
  { id: 'attachments', label: 'The files it was handed' },
  { id: 'conversation', label: 'Its conversation, byte for byte, in its own harness’s format' },
  { id: 'worktree-commits', label: 'Its branch, as the commits the project’s remote does not have' },
  { id: 'worktree-changes', label: 'Uncommitted changes to tracked files' },
  { id: 'worktree-untracked', label: 'New files git does not ignore' },
];
const STAYS = [
  {
    id: 'session-credential',
    label: 'The ferret’s own sign-in to this machine',
    why: 'The other machine mints its own.',
  },
  {
    id: 'ignored-files',
    label: 'Files git ignores (node_modules, .env, build output)',
    why: '.env is a secret and the rest is rebuilt.',
  },
  {
    id: 'secret-values',
    label: 'Secrets and logins',
    why: 'No secret value crosses. The other machine uses its own by name.',
  },
  { id: 'jobs', label: 'Background jobs and terminals', why: 'A move refuses while one is running.' },
];

const forever = (): Promise<never> => new Promise(() => undefined);
const PREFLIGHT = {
  ok: true,
  refusals: [],
  moves: MOVES,
  stays: STAYS,
  files: 14,
  bytes: 183_000,
  largest: [],
  needs: NEEDS,
  ignored: ['.env', 'node_modules'],
  withheld: ['deploy.pem'],
  branch: 'feature/handoff',
  head: 'a'.repeat(40),
};
const EXPORT = {
  exportId: `fy_relocate_export_${'e'.repeat(22)}`,
  header: {
    v: 1,
    offerId: OFFER.offerId,
    sourceDaemonId: SOURCE,
    identityKey: 'AAAA',
    signature: 'AAAA',
    targetDaemonId: TARGET,
    expiresAt: OFFER.expiresAt,
    ephemeralKey: 'AAAA',
    chunks: 3,
    bytes: 183_000,
  },
};

const answerOf = (daemon: string) => async (route: string, init?: { params?: Record<string, string> }) => {
  await new Promise(resolve => setTimeout(resolve, 60));
  if (daemon === SOURCE) {
    if (route === 'POST /v1/relocate/exports/release') return { state: 'stopped' };
    if (route === 'POST /v1/relocate/:ferretId/preflight') return PREFLIGHT;
    if (route === 'POST /v1/relocate/:ferretId/export') return EXPORT;
    if (route === 'GET /v1/relocate/exports/:exportId/chunks/:index') {
      if (params.get('interrupt') === '1' && init?.params?.index === '1')
        await new Promise<void>(resolve => {
          release = resolve;
        });
      if (hold && init?.params?.index === '1') return await forever();
      return new Uint8Array([1, 2, 3]);
    }
    if (route === 'POST /v1/relocate/exports/:exportId/complete') {
      if (params.get('unconfirmed') === '1' && completions++ === 0) throw new Error('Desk did not answer');
      return { ferretId: 'f1', movedTo: { daemonId: TARGET, ferretId: 'g9', at: new Date().toISOString() } };
    }
  } else {
    if (route === 'POST /v1/relocate/imports/:ferretId/start') return {};
    if (route === 'POST /v1/relocate/offers') return OFFER;
    if (route === 'POST /v1/relocate/offers/:offerId/preflight')
      return refuse
        ? {
            ok: false,
            refusals: ['this machine has no claude-code login that can start a ferret: Login main needs sign-in'],
            project: 'found',
            missingSecrets: ['ZAI_API_KEY'],
          }
        : { ok: true, refusals: [], project: 'found', runtime: 'claude-default', missingSecrets: [] };
    if (route === 'PUT /v1/relocate/offers/:offerId/chunks/:index') return { index: Number(init?.params?.index ?? 0) };
    if (route === 'POST /v1/relocate/offers/:offerId/import')
      return {
        ferretId: 'g9',
        folder: '/work/project-feature-handoff-ab12',
        movedFrom: { daemonId: SOURCE, ferretId: 'f1' },
        ...(recovery
          ? {
              recovery: {
                code: 'session_unrestored',
                state: 'stopped',
                message: 'Turns and attachments could not be restored.',
              },
            }
          : {}),
      };
  }
  throw new Error(`unscripted ${route}`);
};

const reach = (daemon: string, machine: string, online = true): DaemonReach =>
  ({
    daemon,
    machine,
    online,
    locked: false,
    authority: () => ({ kind: 'open' }),
    authorityOf: () => ({ kind: 'open' }),
    unlock: async () => true,
    press: async <T,>(act: () => Promise<T>) => await act(),
    hook: () => undefined,
    client: { call: answerOf(daemon) },
  }) as unknown as DaemonReach;

const FROM = reach(SOURCE, 'Desk');
const CANDIDATES = [reach(TARGET, 'Laptop'), reach(`fy_daemon_${'C'.repeat(43)}`, 'Studio', false)];
const MOVED = {
  moved: { f1: { daemonId: TARGET, ferretId: 'g9', machine: 'Laptop', at: '2026-11-27T00:00:00.000Z' as never } },
};
const movedStore = { snapshot: () => MOVED, subscribe: () => () => undefined, refresh: async () => undefined };

function Dialog() {
  const [open, setOpen] = useState(true);
  return (
    <ScreenHrefProvider href={(daemon, _plugin, _screen, ids) => `/d/${daemon}/chat/${ids?.ferret ?? ''}`}>
      {params.get('moved') === '1' ? (
        <div data-stub-scene="" style={{ padding: 24 }}>
          <MovedMark ferret="f1" store={movedStore} />
        </div>
      ) : open ? (
        <MoveMachine
          candidates={CANDIDATES}
          ferret="f1"
          from={FROM}
          name="Zoe"
          onClose={() => setOpen(false)}
          onMoved={() => undefined}
        />
      ) : null}
    </ScreenHrefProvider>
  );
}

const mount = document.getElementById('root');
if (mount !== null) createRoot(mount).render(<Dialog />);
