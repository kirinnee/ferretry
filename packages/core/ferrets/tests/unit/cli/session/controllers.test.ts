import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import { SessionCompactAtController } from '../../../../cli/lib/session/compact-at.ts';
import { renderFerret, renderSessionTable } from '../../../../cli/lib/session/display.ts';
import { SessionCommandError } from '../../../../cli/lib/session/errors.ts';
import { ResumeSessionController } from '../../../../cli/lib/session/lifecycle-controllers.ts';
import { SuggestNamesController } from '../../../../cli/lib/session/name-controller.ts';
import { PinAgentController } from '../../../../cli/lib/session/pin-agent.ts';
import { ListSessionsController } from '../../../../cli/lib/session/ps-controller.ts';
import { RenameSessionController } from '../../../../cli/lib/session/rename-controller.ts';
import { RevokeCredentialController } from '../../../../cli/lib/session/revoke-credential.ts';
import { selectSessions } from '../../../../cli/lib/session/selection.ts';
import { SignalSessionController } from '../../../../cli/lib/session/signal-controller.ts';
import { StartSessionController } from '../../../../cli/lib/session/start-controller.ts';
import { buildStartRequest } from '../../../../cli/lib/session/start-request.ts';
import { SessionStatusController } from '../../../../cli/lib/session/status-controller.ts';
import { SessionSubtreeController } from '../../../../cli/lib/session/subtree-controller.ts';
import { buildSubtree, renderSubtreeTable } from '../../../../cli/lib/session/subtree-table.ts';
import { capturedPresenter, RecordingApi } from './controller-doubles.ts';
import { sessionView } from './session-fixtures.ts';

const PLAIN = { amber: (cell: string) => cell };
const AMBER = { amber: (cell: string) => `<${cell}>` };

const fleet = [
  sessionView({ id: 'lead', name: 'wren' }),
  sessionView({ id: 'mid', name: 'fern', parent: 'lead' }),
  sessionView({ id: 'kid', name: 'ash', parent: 'mid', runtime: undefined }),
  sessionView({ id: 'old', name: 'oak', parent: 'lead', state: 'stopped', stateAt: '2026-11-06T08:00:00.000Z' as never }),
  sessionView({ id: 'solo', name: 'elm', pack: 'batch' as never }),
];

const caught = async (work: Promise<unknown>): Promise<unknown> => await work.then(() => undefined, (error: unknown) => error);

describe('fy ps', () => {
  test('V-0366 lists the running ferrets in a measured table; -a adds the stopped ones', async () => {
    const { io, presenter } = capturedPresenter();
    await new ListSessionsController(new RecordingApi({ list: fleet }), presenter, PLAIN).execute();
    expect(io.out[0]).toMatch(/^TEAMMATE\s+ID\s+STATE\s+HARNESS\s+RUNTIME\s+ROLE\s+PACK\s+PARENT$/u);
    expect(io.out.join('\n')).not.toContain('oak');
    expect(io.reported).toEqual(io.out);

    const all = capturedPresenter();
    await new ListSessionsController(new RecordingApi({ list: fleet }), all.presenter, PLAIN).execute({ all: true });
    expect(all.io.out.join('\n')).toContain('oak');
  });

  test('V-0366 --json reports the selected set, and an empty selection says which filter emptied it', async () => {
    const { io, presenter } = capturedPresenter();
    await new ListSessionsController(new RecordingApi({ list: fleet }), presenter, PLAIN).execute({
      pack: 'batch',
      json: true,
    });
    expect((JSON.parse(io.out[0] ?? '[]') as { id: string }[]).map(row => row.id)).toEqual(['solo']);
    expect(selectSessions(fleet, { pack: 'none' }).emptyMessage).toBe('no ferrets in pack "none"');
    expect(selectSessions([fleet[3]!]).emptyMessage).toBe('no running ferrets (use -a to show stopped ones)');
    expect(selectSessions([]).emptyMessage).toBe('no ferrets');
  });

  test('a running ferret with no runtime is the amber cell, and a PIN column shows only while one is pinned', () => {
    const plain = renderSessionTable(fleet.slice(0, 3), AMBER);
    expect(plain[0]?.startsWith('TEAMMATE')).toBe(true);
    expect(plain[3]).toContain('<-');
    const pinned = renderSessionTable([{ ...fleet[0]!, pinnedAt: '2026-11-01T10:00:00.000Z' as Instant }, fleet[1]!], PLAIN);
    expect(pinned[0]?.startsWith('PIN')).toBe(true);
    expect(pinned[1]?.startsWith('*')).toBe(true);
  });
});

describe('fy status', () => {
  test('V-0445 shows one ferret in detail, or as JSON', async () => {
    const api = new RecordingApi({ get: fleet[1] });
    const { io, presenter } = capturedPresenter();
    await new SessionStatusController(api, presenter).execute('fern');
    expect(io.out).toEqual(renderFerret(fleet[1]!));
    expect(io.out[0]).toContain('fern (mid)');
    expect(io.out[0]).toContain('parent=lead');
    expect(api.calls).toEqual([{ method: 'get', args: ['fern'] }]);
  });

  test('V-0445 --subtree draws the helpers from parent links, indented, an ended one marked', async () => {
    const api = new RecordingApi({ list: fleet, get: fleet[0] });
    const { io, presenter } = capturedPresenter();
    await new SessionSubtreeController(api, presenter, {}, { nowMs: () => Date.parse('2026-11-06T09:00:00.000Z') }).execute(
      'wren',
    );
    expect(io.out[0]).toBe('wren (lead): 3 descendants');
    expect(io.out.slice(2).map(line => line.trimEnd())).toEqual([
      expect.stringMatching(/^fern\s/u),
      expect.stringMatching(/^ {2}ash\s/u),
      expect.stringMatching(/^oak\s.*ended 1h/u),
    ]);
  });

  test('--subtree keeps an ended helper only inside the window, and refuses with no ferret named', async () => {
    const late = buildSubtree(fleet, fleet[0]!, Date.parse('2026-11-06T12:00:00.000Z'));
    expect(late.rows.map(row => row.id)).toEqual(['mid', 'kid']);
    expect(renderSubtreeTable(buildSubtree([], fleet[0]!), undefined)).toEqual([
      'wren (lead): 0 descendants; ended ones show for 120m',
    ]);
    const { presenter } = capturedPresenter();
    expect(await caught(new SessionSubtreeController(new RecordingApi(), presenter, {}).execute(undefined))).toBeInstanceOf(
      SessionCommandError,
    );
  });
});

describe('fy name', () => {
  test('V-0333 prints the suggested callsigns, as lines or JSON, and refuses a count that is not whole', async () => {
    const api = new RecordingApi({ suggestNames: ['ash', 'elm'] });
    const { io, presenter } = capturedPresenter();
    await new SuggestNamesController(api, presenter).execute({ count: 2 });
    await new SuggestNamesController(api, presenter).execute({ json: true });
    expect(io.out).toEqual(['ash', 'elm', JSON.stringify(['ash', 'elm'], null, 2)]);
    expect(api.calls).toEqual([
      { method: 'suggestNames', args: [2] },
      { method: 'suggestNames', args: [1] },
    ]);
    expect(await caught(new SuggestNamesController(api, presenter).execute({ count: Number('banana') }))).toBeInstanceOf(
      SessionCommandError,
    );
  });
});

describe('fy rename', () => {
  test('V-0371 checks the name against the ferret name grammar, then lets the daemon claim it', async () => {
    const api = new RecordingApi();
    const { io, presenter } = capturedPresenter();
    await new RenameSessionController(api, presenter).execute(' wren ', 'mary-jane');
    expect(api.calls).toEqual([{ method: 'rename', args: ['wren', { name: 'mary-jane' }] }]);
    expect(io.out).toEqual(['renamed wren: Mary-Jane']);
  });

  test('V-0371 --title sends a new task title, alongside or instead of a name, and shows it', async () => {
    const api = new RecordingApi();
    const { io, presenter } = capturedPresenter();
    const subject = new RenameSessionController(api, presenter);
    await subject.execute('wren', undefined, { title: ' Fix the login ' });
    await subject.execute('wren', 'ash', { title: 'New title' });
    expect(api.calls).toEqual([
      { method: 'rename', args: ['wren', { title: 'Fix the login' }] },
      { method: 'rename', args: ['wren', { name: 'ash', title: 'New title' }] },
    ]);
    expect(io.out).toEqual(['renamed wren: Wren — Fix the login', 'renamed wren: Ash — New title']);
  });

  test('V-0371 refuses no name and no title, and a bad name, before anything is sent', async () => {
    const api = new RecordingApi();
    const { presenter } = capturedPresenter();
    const subject = new RenameSessionController(api, presenter);
    for (const attempt of [
      subject.execute('wren', undefined),
      subject.execute('wren', '  ', { title: '  ' }),
      subject.execute('wren', 'no/slash'),
    ])
      expect(await caught(attempt)).toBeInstanceOf(SessionCommandError);
    expect(api.calls).toEqual([]);
  });
});

describe('fy resume', () => {
  test('V-0376 revives the ferret and shows it, sending a message to deliver on revival', async () => {
    const api = new RecordingApi({ get: fleet[0] });
    const { io, presenter } = capturedPresenter();
    await new ResumeSessionController(api, presenter).execute('wren');
    await new ResumeSessionController(api, presenter).execute('wren', { message: ' go on ' });
    expect(api.calls.filter(call => call.method === 'resume')).toEqual([
      { method: 'resume', args: ['wren', undefined] },
      { method: 'resume', args: ['wren', 'go on'] },
    ]);
    expect(io.out[0]).toContain('wren (lead)');
  });
});

describe('fy signal', () => {
  test('V-0437 records a signal for the named ferret, and a declared wait says what it waits for', async () => {
    const api = new RecordingApi({ signal: { waiting: { peer: 'p1', peerName: 'fern', until: '2026-11-06T10:00:00.000Z' } } });
    const { io, presenter } = capturedPresenter();
    const subject = new SignalSessionController(api, presenter, {});
    await subject.execute('waiting', undefined, { session: 'wren', peer: 'fern', until: '1h' });
    expect(api.calls[0]).toEqual({
      method: 'signal',
      args: ['wren', 'waiting', undefined, { until: '1h', peer: 'fern' }],
    });
    expect(io.out[0]).toStartWith('waiting recorded for a reply from fern until 2026-11-06T10:00:00.000Z');
  });

  test('V-0437 refuses an unknown kind, no ferret, help without a message and wait flags on another kind', async () => {
    const api = new RecordingApi();
    const { presenter } = capturedPresenter();
    const subject = new SignalSessionController(api, presenter, {});
    for (const attempt of [
      subject.execute('finished', undefined, { session: 'wren' }),
      subject.execute('done', undefined, {}),
      subject.execute('help', undefined, { session: 'wren' }),
      subject.execute('done', undefined, { session: 'wren', until: '1h' }),
    ])
      expect(await caught(attempt)).toBeInstanceOf(SessionCommandError);
    expect(api.calls).toEqual([]);
  });
});

describe('fy start', () => {
  test('V-0443 sends the folder, runtime, name and prompt Ferrets start takes, then shows the ferret', async () => {
    const api = new RecordingApi({ get: { ...fleet[0]!, state: 'starting' } });
    const { io, presenter } = capturedPresenter();
    await new StartSessionController(api, presenter, { cwd: '/work/repo' }, 'fy').execute({
      mode: 'auto',
      agent: 'claude-alpha',
      teammate: 'wren',
      cwd: 'sub',
      prompt: ' fix the bug ',
    });
    expect(api.calls[0]).toEqual({
      method: 'start',
      args: [
        { folder: '/work/repo/sub', runtime: 'claude-alpha', name: 'wren', prompt: 'fix the bug', mode: 'auto' },
      ],
    });
    expect(io.err).toEqual(['note: lead is still starting — watch it with `fy ps` or `fy status lead`']);
  });

  test('V-0443 sends today’s start fields with today’s wire names, and a short --turn-timeout earns a note', async () => {
    const api = new RecordingApi({ get: fleet[0] });
    const { io, presenter } = capturedPresenter();
    await new StartSessionController(api, presenter, { cwd: '/w' }, 'fy').execute({
      mode: 'auto',
      prompt: 'go',
      title: 'Fix login',
      label: 'mine',
      card: '&f21',
      model: 'opus',
      effort: 'high',
      fast: false,
      remoteControl: true,
      harnessFlags: ['--verbose'],
      teammateFallback: true,
      interval: 30,
      turnTimeout: 60,
      nudgeAfter: 0,
      stallKillAfter: 900,
      directMax: 200,
      maxSnapshots: 5,
    });
    expect(api.calls[0]?.args[0]).toEqual({
      folder: '/w',
      prompt: 'go',
      mode: 'auto',
      teammateFallback: true,
      title: 'Fix login',
      label: 'mine',
      card: 'F21',
      model: 'opus',
      effort: 'high',
      fast: false,
      remoteControl: true,
      harnessFlags: ['--verbose'],
      intervalSeconds: 30,
      timeoutSeconds: 60,
      nudgeAfterSeconds: 0,
      killAfterSeconds: 900,
      directSendMaxChars: 200,
      maxSnapshots: 5,
    });
    expect(io.err[0]).toContain('--turn-timeout is a hard KILL timer');
  });

  test('V-0443 a numeric flag that is not a whole number at its floor, or a bad card, is refused before sending', () => {
    expect(() => buildStartRequest({ mode: 'interactive', interval: 0 }, { cwd: '/w' })).toThrow(
      '--interval must be an integer of at least 1',
    );
    expect(() => buildStartRequest({ mode: 'interactive', nudgeAfter: Number('soon') }, { cwd: '/w' })).toThrow(
      '--nudge-after must be an integer of at least 0',
    );
    expect(() => buildStartRequest({ mode: 'interactive', card: 'F0' }, { cwd: '/w' })).toThrow('&F21');
  });

  test('V-0443 an auto start needs a prompt; an interactive one may start bare; with no folder it says how', () => {
    expect(() => buildStartRequest({ mode: 'auto' }, { cwd: '/w' })).toThrow(SessionCommandError);
    expect(buildStartRequest({ mode: 'interactive' }, { cwd: '/w' })).toEqual({ folder: '/w', mode: 'interactive' });
    expect(buildStartRequest({ mode: 'interactive', cwd: '/abs' }, {})).toEqual({ folder: '/abs', mode: 'interactive' });
    expect(() => buildStartRequest({ mode: 'interactive', cwd: 'rel' }, {})).toThrow(/--cwd <absolute path>/u);
  });
});

describe('fy session', () => {
  test('V-0434 revoke-credential says what it cuts off and what it does not', async () => {
    const asked: string[] = [];
    const { io, presenter } = capturedPresenter();
    const subject = new RevokeCredentialController(
      {
        revoke: async session => {
          asked.push(`revoke ${session}`);
          return { id: 'lead', revoked: true };
        },
        state: async session => {
          asked.push(`state ${session}`);
          return 'working';
        },
      },
      presenter,
      'fy',
    );
    await subject.execute(' wren ');
    expect(asked).toEqual(['revoke wren', 'state lead']);
    expect(io.out[0]).toStartWith("revoked lead's credential");
    expect(io.out[2]).toContain('fy stop orphan lead');
    expect(await caught(subject.execute('  '))).toBeInstanceOf(SessionCommandError);
  });

  test('V-0433 V-0435 pin and unpin the named ferret and say so', async () => {
    const asked: string[] = [];
    const { io, presenter } = capturedPresenter();
    const subject = new PinAgentController(
      {
        pin: async session => {
          asked.push(`pin ${session}`);
          return { ...fleet[0]!, pinnedAt: '2026-11-01T10:00:00.000Z' as Instant };
        },
        unpin: async session => {
          asked.push(`unpin ${session}`);
          return fleet[0]!;
        },
      },
      presenter,
    );
    await subject.pin(' wren ');
    await subject.unpin('lead');
    expect(asked).toEqual(['pin wren', 'unpin lead']);
    expect(io.out).toEqual(['pinned wren (lead) to the top of the sidebar', 'unpinned wren (lead)']);
    expect(await caught(subject.pin(' '))).toBeInstanceOf(SessionCommandError);
  });

  test('V-0432 compact-at reads with no value, sends a size or inherit, and refuses a bad size', async () => {
    const asked: string[] = [];
    const { io, presenter } = capturedPresenter();
    const subject = new SessionCompactAtController(
      {
        read: async session => {
          asked.push(`read ${session}`);
          return { effective: 250_000, own: 250_000, note: 'Memory is compacted at 250k tokens.' };
        },
        write: async (session, change) => {
          asked.push(`write ${session} ${JSON.stringify(change)}`);
          return { restartRequired: true, note: 'It takes effect when the ferret restarts.' };
        },
      },
      presenter,
    );
    await subject.run(' wren ', undefined);
    await subject.run('wren', '400k');
    await subject.run('wren', 'inherit');
    expect(asked).toEqual([
      'read wren',
      'write wren {"compactAt":400000}',
      'write wren {"compactAt":"inherit"}',
    ]);
    expect(io.out[0]).toBe('compact at 250k');
    expect(await caught(subject.run('wren', 'lots'))).toBeInstanceOf(SessionCommandError);
  });
});
