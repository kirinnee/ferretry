/**
 * WHAT AGENDA PROVES IN AN ASK'S WORDS (`!A3`, `:agent`, `@file`): each only from the evidence in hand, on top of the
 * surface the ask sits in, and never over a kind that surface already proves.
 */
import { describe, test } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import type { FerretsFileOpen } from '@ferretry/core-ferrets/contract';
import should from 'should';
import {
  type AgendaFerretReferences,
  type AgendaReferenceFacts,
  agendaReferenceSurface,
  referenceFleetKey,
} from '../../../app/lib/agenda-references.ts';
import type { FerretView } from '../../../app/lib/ferret-view.ts';
import { daemonId } from '../../../app/shell.ts';

const DAEMON = daemonId('d1');
const view = (id: string, teammate: string, status: FerretView['state']['status'], cwd?: string): FerretView => ({
  config: { id, teammate, ...(cwd === undefined ? {} : { cwd }) },
  state: { status },
});
const FLEET = [view('f1', 'aniya', 'working', '/repo'), view('f2', 'torrey', 'stopped')];

const client = (listings: Readonly<Record<string, unknown>>) => {
  const calls: Array<Record<string, string> | undefined> = [];
  return {
    calls,
    call: async (_route: string, request?: { query?: Record<string, string> }) => {
      calls.push(request?.query);
      const answer = listings[request?.query?.path ?? ''];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as never;
};

const FILE_OPEN: FerretsFileOpen = { open: () => true };

const facts = (over: Partial<AgendaReferenceFacts> = {}): AgendaReferenceFacts => ({
  daemonId: DAEMON,
  fleet: FLEET,
  client: client({}),
  fileOpen: undefined,
  onNavigate: () => undefined,
  ...over,
});

const ferretPage = (over: Partial<AgendaFerretReferences> = {}): AgendaFerretReferences => ({
  id: 'f1',
  ledger: ['A1', 'A3'],
  openAsk: () => undefined,
  showFiles: () => undefined,
  ...over,
});

describe('referenceFleetKey', () => {
  test('should read liveness, callsigns and the one ferret’s folder, and nothing else', () => {
    const base = referenceFleetKey(FLEET, 'f1');

    should(referenceFleetKey(undefined, 'f1')).equal('');
    should(referenceFleetKey(null, 'f1')).equal('');
    // working <-> awaiting a question moves nothing the proofs read; a ferret finishing, a new callsign or the folder does
    should(referenceFleetKey([view('f1', 'aniya', 'idle', '/repo'), FLEET[1] as FerretView], 'f1')).equal(base);
    should(referenceFleetKey([view('f1', 'aniya', 'stopped', '/repo'), FLEET[1] as FerretView], 'f1')).not.equal(base);
    should(referenceFleetKey([view('f1', 'kim', 'working', '/repo'), FLEET[1] as FerretView], 'f1')).not.equal(base);
    should(referenceFleetKey([view('f1', 'aniya', 'working', '/moved'), FLEET[1] as FerretView], 'f1')).not.equal(base);
    // another ferret's folder is not read, and a page with no ferret of its own reads none
    should(referenceFleetKey([FLEET[0] as FerretView, view('f2', 'torrey', 'stopped', '/x')], 'f1')).equal(base);
    should(referenceFleetKey(FLEET, undefined)).not.equal(base);
  });
});

describe('agendaReferenceSurface :agent', () => {
  test('should prove a ferret of the fleet and stamp this daemon', () => {
    const surface = agendaReferenceSurface({}, facts());

    should(surface.agentReferenceResolver?.({ name: 'aniya' })).deepEqual({
      daemonId: DAEMON,
      sessionId: 'f1',
      name: 'aniya',
    });
    should(surface.agentReferenceResolver?.({ sessionId: 'f2' })).deepEqual({
      daemonId: DAEMON,
      sessionId: 'f2',
      name: 'torrey',
    });
    should(surface.agentReferenceResolver?.({ name: 'nobody' })).be.null();
  });

  test('should prove nothing before the fleet is read', () => {
    should(agendaReferenceSurface({}, facts({ fleet: null })).agentReferenceResolver).be.undefined();
  });

  test('should offer navigation, and leave the surface’s own proof and navigation alone', () => {
    const own = () => ({ daemonId: DAEMON, sessionId: 'x', name: 'own' });
    const navigate = () => undefined;
    const surface = agendaReferenceSurface({ agentReferenceResolver: own, onNavigate: navigate }, facts());

    should(surface.agentReferenceResolver).equal(own);
    should(surface.onNavigate).equal(navigate);
    should(typeof agendaReferenceSurface({}, facts()).onNavigate).equal('function');
  });
});

describe('agendaReferenceSurface !A3', () => {
  test('should prove an item on the ferret’s own ledger, open or resolved, and open it', () => {
    const opened: string[] = [];
    const surface = agendaReferenceSurface({}, facts({ ferret: ferretPage({ openAsk: id => opened.push(id) }) }));

    should(surface.agendaReferenceResolver?.('A3')).be.true();
    should(surface.agendaReferenceResolver?.('A9')).be.false();
    surface.onAgendaOpen?.('A3');
    should(opened).deepEqual(['A3']);
  });

  test('should prove none on a page with no ferret of its own (the machine-wide Inbox)', () => {
    const surface = agendaReferenceSurface({}, facts());

    should(surface.agendaReferenceResolver).be.undefined();
    should(surface.onAgendaOpen).be.undefined();
  });

  test('should leave a surface that already proves attention items as it is', () => {
    const own = () => true;
    const surface = agendaReferenceSurface({ agendaReferenceResolver: own }, facts({ ferret: ferretPage() }));

    should(surface.agendaReferenceResolver).equal(own);
  });
});

describe('agendaReferenceSurface @file', () => {
  const listed = { src: { entries: [{ name: 'a.ts', type: 'file' }] } };

  test('should prove a listed file of this ferret and open it in Files, then show Files', async () => {
    const asked: Array<[string, string]> = [];
    let shown = 0;
    const surface = agendaReferenceSurface(
      {},
      facts({
        client: client(listed),
        fileOpen: { open: (ferret, path) => (asked.push([ferret, path]), true) },
        ferret: ferretPage({ showFiles: () => (shown += 1) }),
      }),
    );

    const proved = await surface.resolveFilePaths?.(['/repo/src/a.ts'], new AbortController().signal);
    surface.onCodeReferenceOpen?.({ path: 'src/a.ts' });

    should([...(proved ?? [])]).deepEqual([['/repo/src/a.ts', 'src/a.ts']]);
    should(asked).deepEqual([['f1', 'src/a.ts']]);
    should(shown).equal(1);
  });

  test('should not show Files when the opener refused the path', () => {
    let shown = 0;
    const surface = agendaReferenceSurface(
      {},
      facts({ fileOpen: { open: () => false }, ferret: ferretPage({ showFiles: () => (shown += 1) }) }),
    );

    surface.onCodeReferenceOpen?.({ path: '../x' });

    should(shown).equal(0);
  });

  test('should prove nothing without the ferrets.file-open hook, and ask the daemon nothing', () => {
    const asked = client(listed);
    const surface = agendaReferenceSurface({}, facts({ client: asked, ferret: ferretPage() }));

    should(surface.resolveFilePaths).be.undefined();
    should(surface.onCodeReferenceOpen).be.undefined();
    should((asked as unknown as { calls: unknown[] }).calls.length).equal(0);
  });

  test('should prove nothing on a page with no ferret of its own', () => {
    const surface = agendaReferenceSurface({}, facts({ fileOpen: FILE_OPEN }));

    should(surface.resolveFilePaths).be.undefined();
  });

  test('should prove nothing when the listing is refused for want of the filesystem grant', async () => {
    const surface = agendaReferenceSurface(
      {},
      facts({
        client: client({ src: new DaemonCallError(403, 'forbidden', 'filesystem is off') }),
        fileOpen: FILE_OPEN,
        ferret: ferretPage(),
      }),
    );

    const proved = await surface.resolveFilePaths?.(['src/a.ts'], new AbortController().signal);

    should(proved?.size).equal(0);
  });

  test('should make an absolute path relative only to the ferret’s own folder', async () => {
    const asked = client({ '': { entries: [{ name: 'a.ts', type: 'file' }] } });
    const surface = agendaReferenceSurface(
      {},
      facts({ client: asked, fileOpen: FILE_OPEN, ferret: ferretPage({ id: 'f2' }) }),
    );

    // f2 has no folder in the fleet, so an absolute path names nothing for it.
    const proved = await surface.resolveFilePaths?.(['/repo/a.ts'], new AbortController().signal);

    should(proved?.size).equal(0);
    should((asked as unknown as { calls: unknown[] }).calls.length).equal(0);
  });

  test('should leave a surface that already proves files as it is', () => {
    const own = async () => new Map<string, string>();
    const surface = agendaReferenceSurface(
      { resolveFilePaths: own },
      facts({ fileOpen: FILE_OPEN, ferret: ferretPage() }),
    );

    should(surface.resolveFilePaths).equal(own);
  });
});
