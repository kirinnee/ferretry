import { describe, expect, it } from 'bun:test';
import type { Op } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { SurfaceControl } from '../../../daemon/lib/agent-tools/control.ts';
import {
  type TerminalToolCall,
  type TerminalToolPorts,
  TerminalToolService,
} from '../../../daemon/lib/agent-tools/service.ts';
import type { AgentToolCaller, RecordedSurfaceEvent } from '../../../daemon/lib/agent-tools/types.ts';
import { TerminalMountError } from '../../../daemon/lib/runtime/mounts/terminals.ts';

const SESSION = 'f-1';
const AT = '2026-11-07T10:00:00.000Z';
const agent: AgentToolCaller = { kind: 'agent', sessionId: SESSION, name: 'Hadi' };
const person: AgentToolCaller = { kind: 'person', sessionId: SESSION };

interface Row {
  id: string;
  name?: string;
  title: string;
  openedBy?: { by: 'agent'; sessionId: string } | { by: 'local' };
}

/** The tool service over in-memory terminals, a real control book, and an act runner a test can make refuse. */
function world(
  options: {
    rows?: Row[];
    refuse?: 'quarantined' | 'held' | 'input_pending' | 'target_gone' | 'hold_unavailable';
    history?: RecordedSurfaceEvent[];
    publishFails?: boolean;
    raiseInput?: TerminalToolPorts['raiseInput'] | 'none';
    screens?: string[];
    foreground?: () => Promise<string>;
  } = {},
) {
  const rows: Row[] = options.rows ?? [];
  const published: { type: string; data: unknown }[] = [];
  const written: string[] = [];
  const screens = [...(options.screens ?? ['$ '])];
  let now = 1_000_000;
  let historyReads = 0;
  const control = new SurfaceControl(
    {
      publish: async (_session, type, data) => {
        if (options.publishFails === true) throw new Error('journal is full');
        published.push({ type, data });
      },
      history: async () => {
        historyReads += 1;
        return options.history ?? [];
      },
    },
    { now: () => now },
  );
  const ports: TerminalToolPorts = {
    terminals: {
      list: async () => ({ terminals: rows, slots: 0 }) as never,
      create: async (_session, input, openedBy) => {
        const row: Row = {
          id: `t-${rows.length + 1}`,
          name: input.name,
          title: input.name ?? 'terminal',
          openedBy: openedBy as never,
        };
        rows.push(row);
        return row as never;
      },
      write: async (_s, _id, bytes) => {
        written.push(new TextDecoder().decode(bytes));
      },
      text: async () => (screens.length > 1 ? screens.shift() : screens[0]) ?? '',
      foreground: options.foreground ?? (async () => 'bash'),
      close: async (_s, id) => {
        rows.splice(
          rows.findIndex(row => row.id === id),
          1,
        );
      },
    },
    control,
    act: async (_id, _op: Op, fn) =>
      options.refuse === undefined ? ok(await fn()) : err({ refused: options.refuse } as never),
    read: async fn => fn({ text: (value: string) => value.replaceAll('hunter2', '***') } as never),
    clock: { now: () => now },
    sleep: async ms => {
      now += ms;
    },
    ...(options.raiseInput === 'none' ? {} : { raiseInput: options.raiseInput ?? (async () => ok('r-1' as never)) }),
  };
  const service = new TerminalToolService(ports);
  return {
    service,
    control,
    rows,
    published,
    written,
    historyReads: () => historyReads,
    advance: (ms: number) => (now += ms),
  };
}

const mine: Row = { id: 't-1', name: 'dev', title: 'dev', openedBy: { by: 'agent', sessionId: SESSION } };
const theirs: Row = { id: 't-2', name: 'logs', title: 'logs', openedBy: { by: 'local' } };

const refusalOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('expected a refusal');
};

describe('listing terminals', () => {
  it('says there are none, and then names each, a person seeing every one', async () => {
    const empty = world();
    expect((await empty.service.call(agent, { tool: 'terminal.list' })).summary).toBe(
      'No terminals are open for you in this session.',
    );
    const full = world({ rows: [mine, theirs] });
    const listed = await full.service.call(person, { tool: 'terminal.list' });
    expect(listed.summary).toBe('2 terminals: %terminal:dev, %terminal:logs.');
    expect(listed.surfaces).toEqual([
      { id: 't-1', name: 'dev', title: 'dev' },
      { id: 't-2', name: 'logs', title: 'logs' },
    ]);
  });

  it('shows an agent only the terminals it may use: its own, or one a person handed over', async () => {
    const w = world({ rows: [mine, theirs, { id: 't-3', title: 'bare' }] });
    const first = await w.service.call(agent, { tool: 'terminal.list' });
    expect(first.surfaces).toEqual([{ id: 't-1', name: 'dev', title: 'dev', available: true }]);
    expect(first.summary).toBe('1 terminal: %terminal:dev.');
    await w.service.control(SESSION, { action: 'handover', key: 'logs' }, { by: 'local' });
    const second = await w.service.call(agent, { tool: 'terminal.list' });
    expect(second.surfaces?.map(row => row.name)).toEqual(['dev', 'logs']);
  });
});

describe('opening a terminal', () => {
  it('starts the command and announces the terminal and the ask to the owner', async () => {
    const w = world();
    const opened = await w.service.call(agent, {
      tool: 'terminal.open',
      name: 'dev',
      command: 'bun test',
      askOwner: 'sign in',
    });
    expect(opened.summary).toBe(
      'Opened %terminal:dev and started the command and asked the owner to take over (wait for them).',
    );
    expect(w.written).toEqual(['bun test\r']);
    expect(w.published.map(event => event.type)).toEqual(['surface.driving', 'surface.opened', 'surface.asked']);
  });

  it('records a person’s open under who they are, and announces nothing', async () => {
    const w = world();
    await w.service.call({ ...person, openedBy: { by: 'local' } }, { tool: 'terminal.open', name: 'dev' });
    expect(w.rows[0]?.openedBy).toEqual({ by: 'local' });
    expect(w.published).toEqual([]);
  });

  it('does not fail an open when the journal cannot take its courtesy events, but does for an explicit ask', async () => {
    const w = world({ publishFails: true });
    const opened = await w.service.call(agent, { tool: 'terminal.open', name: 'dev', askOwner: true });
    expect(opened.summary).toContain('Opened %terminal:dev');
    const failed = await refusalOf(w.service.call(agent, { tool: 'terminal.ask_owner', name: 'dev' }));
    expect(failed.message).toBe('journal is full');
  });
});

describe('the tools that need a terminal', () => {
  it('refuses a terminal that is not in the ferret, with the way to find one', async () => {
    const w = world();
    const refused = await refusalOf(w.service.call(agent, { tool: 'terminal.read', name: 'nope' }));
    expect(refused.code).toBe('not_found');
    expect(refused.message).toContain('There is no %terminal:nope in this session. List them with terminal.list');
  });

  it('refuses an agent a terminal that is a person’s, until they hand it over', async () => {
    const w = world({ rows: [theirs] });
    const refused = await refusalOf(w.service.call(agent, { tool: 'terminal.send', name: 'logs', text: 'x' }));
    expect(refused.code).toBe('forbidden');
    expect(refused.message).toContain("is a person's, not yours");
    await w.service.control(SESSION, { action: 'handover', key: 'logs' }, { by: 'human', deviceId: 'phone' });
    expect(
      (await w.service.call(agent, { tool: 'terminal.send', name: 'logs', text: 'x', keys: ['enter'] })).summary,
    ).toBe('Sent 1 character and 1 key to %terminal:logs.');
  });

  it('refuses an agent a terminal a person has taken over, and lets it back in after the hand back', async () => {
    const w = world({ rows: [mine] });
    const view = await w.service.control(SESSION, { action: 'takeover', key: 'dev' }, { by: 'local' });
    expect(view.takeovers).toHaveLength(1);
    const refused = await refusalOf(w.service.call(agent, { tool: 'terminal.read', name: 'dev' }));
    expect(refused.code).toBe('taken_over');
    expect(refused.message).toBe('A person has taken over %terminal:dev; wait or ask them.');
    expect((await w.service.call(person, { tool: 'terminal.read', name: 'dev' })).output).toBe('$ ');
    const back = await w.service.control(SESSION, { action: 'handback', key: 'dev' }, { by: 'local' });
    expect(back.takeovers).toEqual([]);
    expect((await w.service.call(agent, { tool: 'terminal.read', name: 'dev' })).summary).toContain('The last');
  });

  it('answers a control change on a terminal that is not there in the terminals’ own words', async () => {
    const w = world();
    const refused = await refusalOf(w.service.control(SESSION, { action: 'takeover', key: 'nope' }, { by: 'local' }));
    expect(refused.code).toBe('not_found');
  });

  it('only lets an agent hand a terminal to its owner or ask for a value', async () => {
    const w = world({ rows: [mine] });
    const ask = await refusalOf(w.service.call(person, { tool: 'terminal.ask_owner', name: 'dev' }));
    expect([ask.code, ask.message]).toEqual([
      'bad_request',
      'Only an agent hands a surface to its owner; you already have it.',
    ]);
    const input = await refusalOf(
      w.service.call(person, { tool: 'terminal.request_input', name: 'dev', raise: {} as never }),
    );
    expect(input.message).toBe('Only an agent asks its owner for a value; you already have the terminal.');
  });

  it('refuses a request for input on a machine that cannot raise one, and passes a refusal on', async () => {
    const none = world({ rows: [mine], raiseInput: 'none' });
    const unavailable = await refusalOf(
      none.service.call(agent, { tool: 'terminal.request_input', name: 'dev', raise: {} as never }),
    );
    expect([unavailable.code, unavailable.message]).toEqual([
      'unavailable',
      'Input requests are not available on this machine.',
    ]);
    const conflict = world({ rows: [mine], raiseInput: async () => err('another card is open') });
    const refused = await refusalOf(
      conflict.service.call(agent, { tool: 'terminal.request_input', name: 'dev', raise: {} as never }),
    );
    expect([refused.code, refused.message]).toEqual(['conflict', 'another card is open']);
    const raised = world({ rows: [mine] });
    const answer = await raised.service.call(agent, {
      tool: 'terminal.request_input',
      name: 'dev',
      raise: {} as never,
    });
    expect(answer.input).toEqual({ id: 'r-1' });
    expect(answer.summary).toContain('!r-1');
  });

  it('closes a terminal and forgets what stood about it', async () => {
    const w = world({ rows: [mine] });
    await w.service.control(SESSION, { action: 'handover', key: 'dev' }, { by: 'local' });
    expect((await w.service.call(agent, { tool: 'terminal.close', name: 'dev' })).summary).toBe(
      'Closed %terminal:dev.',
    );
    expect(w.rows).toEqual([]);
    expect((await w.control.view(SESSION, 'terminal')).handed).toEqual([]);
  });
});

describe('when a hold refuses the act', () => {
  const cases: [string, string, string][] = [
    ['quarantined', 'conflict', "is quarantined: the owner's secret was just typed there"],
    ['held', 'conflict', "is quarantined: the owner's secret was just typed there"],
    ['input_pending', 'conflict', 'an input request is pending on %terminal:dev'],
    ['target_gone', 'not_found', 'There is no %terminal:dev in this session any more.'],
    ['hold_unavailable', 'unavailable', '%terminal:dev cannot be acted on right now (hold_unavailable).'],
  ];
  for (const [refused, code, sentence] of cases)
    it(`says ${refused} in this domain’s words`, async () => {
      const w = world({ rows: [mine], refuse: refused as never });
      const error = await refusalOf(w.service.call(agent, { tool: 'terminal.read', name: 'dev' }));
      expect(error.code).toBe(code);
      expect(error.message).toContain(sentence);
    });

  it('tells a person about a quarantine in their own words', async () => {
    const w = world({ rows: [mine], refuse: 'quarantined' });
    const error = await refusalOf(w.service.call(person, { tool: 'terminal.read', name: 'dev' }));
    expect(error.message).toBe(
      '%terminal:dev is quarantined: a secret was just typed there. End the quarantine from its input card, or try again shortly.',
    );
  });
});

describe('waiting on a terminal', () => {
  it('ends when the shell is back in the foreground, and says the command ended', async () => {
    const w = world({ rows: [mine], screens: ['$ done'] });
    const waited = await w.service.call(agent, { tool: 'terminal.wait', name: 'dev', exit: true, timeoutMs: 5_000 });
    expect(waited).toEqual({ summary: 'The command ended in %terminal:dev.', matched: true, output: '$ done' });
  });

  it('keeps waiting while a program runs, and times out saying so with what is on screen', async () => {
    const w = world({ rows: [mine], foreground: async () => 'vim', screens: ['editing'] });
    const waited = await w.service.call(person, { tool: 'terminal.wait', name: 'dev', exit: true, timeoutMs: 600 });
    expect(waited.matched).toBe(false);
    expect(waited.summary).toBe('Still waiting on %terminal:dev: the wait timed out.');
    expect(waited.output).toBe('editing');
  });

  it('reads the text it waits for masked, so a typed secret cannot be matched', async () => {
    const w = world({ rows: [mine], screens: ['login: hunter2', 'login: hunter2', 'login: hunter2'] });
    const hidden = await w.service.call(person, {
      tool: 'terminal.wait',
      name: 'dev',
      text: 'hunter2',
      timeoutMs: 300,
    });
    expect(hidden.matched).toBe(false);
    expect(hidden.output).toBe('login: ***');
    const seen = await w.service.call(person, { tool: 'terminal.wait', name: 'dev', text: 'login', timeoutMs: 300 });
    expect(seen).toMatchObject({ summary: 'The text appeared in %terminal:dev.', matched: true });
  });

  it('reports a terminal that closed under the wait as matched', async () => {
    const gone = world({
      rows: [mine],
      foreground: async () => {
        throw new TerminalMountError('not_found', 'no such terminal');
      },
    });
    expect(await gone.service.call(agent, { tool: 'terminal.wait', name: 'dev', exit: true })).toEqual({
      summary: '%terminal:dev closed while waiting.',
      matched: true,
    });
    const broken = world({
      rows: [mine],
      foreground: async () => {
        throw new TerminalMountError('capacity', 'tmux is busy');
      },
    });
    const refused = await refusalOf(broken.service.call(agent, { tool: 'terminal.wait', name: 'dev', exit: true }));
    expect([refused.code, refused.message]).toEqual(['capacity', 'tmux is busy']);
  });

  it('stops an agent’s wait the moment a person takes the terminal over', async () => {
    const w = world({ rows: [mine] });
    await w.service.control(SESSION, { action: 'takeover', key: 'dev' }, { by: 'local' });
    const refused = await refusalOf(w.service.call(agent, { tool: 'terminal.wait', name: 'dev', exit: true }));
    expect(refused.code).toBe('taken_over');
  });
});

describe('an error that is nobody’s refusal', () => {
  it('passes a genuine defect through untouched', async () => {
    const w = world({
      rows: [mine],
      foreground: async () => {
        throw new TypeError('a genuine defect');
      },
    });
    const call: TerminalToolCall = { tool: 'terminal.wait', name: 'dev', exit: true };
    const error = await refusalOf(w.service.call(agent, call));
    expect(error).toBeInstanceOf(TypeError);
  });
});

describe('the control view', () => {
  it('keeps only the tabs and asks of terminals that are still alive, and reads the journal once', async () => {
    const w = world({ rows: [mine] });
    await w.service.call(agent, { tool: 'terminal.ask_owner', name: 'dev', message: 'look' });
    expect((await w.service.controlView(SESSION)).asked).toHaveLength(1);
    w.rows.length = 0;
    const view = await w.service.controlView(SESSION);
    expect([view.opened, view.asked]).toEqual([[], []]);
    expect(w.historyReads()).toBe(1);
  });
});

describe('what a person has done to a terminal, remembered across a restart', () => {
  const event = (type: string, data: unknown): RecordedSurfaceEvent => ({ type, data });
  const surface = { surface: 'terminal', id: 't-1', name: 'dev' };

  it('replays takeovers, hand backs, opens, asks and hand overs from the journal, and ignores what does not parse', async () => {
    const w = world({
      rows: [mine],
      history: [
        event('surface.takeover', { ...surface, by: { by: 'local' }, since: AT }),
        event('surface.takeover', { nonsense: true }),
        event('surface.opened', { ...surface, agentSessionId: SESSION, at: AT }),
        event('surface.opened', { nonsense: true }),
        event('surface.asked', { ...surface, agentSessionId: SESSION, at: AT }),
        event('surface.asked', { nonsense: true }),
        event('surface.handed', { ...surface, by: { by: 'local' }, at: AT }),
        event('surface.handed', { nonsense: true }),
        event('surface.driving', {}),
        event('surface.handback', { nonsense: true }),
      ],
    });
    const view = await w.control.view(SESSION, 'terminal');
    expect(view.takeovers).toHaveLength(1);
    expect(view.opened).toHaveLength(1);
    // The standing takeover clears the ask that came after it only if it came before; this ask came after.
    expect(view.asked).toHaveLength(1);
    expect(view.handed).toHaveLength(1);
    expect(await w.control.isHanded(SESSION, { surface: 'terminal', id: 't-1' })).toBe(true);
    expect(await w.control.isHanded(SESSION, { surface: 'terminal', id: 't-9' })).toBe(false);
  });

  it('lets a later hand back release a takeover and clear the ask', async () => {
    const w = world({
      history: [
        event('surface.asked', { ...surface, agentSessionId: SESSION, at: AT }),
        event('surface.takeover', { ...surface, by: { by: 'human', deviceId: 'phone' }, since: AT }),
        event('surface.handback', { ...surface, at: AT }),
      ],
    });
    const view = await w.control.view(SESSION, 'terminal');
    expect([view.takeovers, view.asked]).toEqual([[], []]);
  });

  it('asks the journal again after it could not be read, rather than remembering it as empty', async () => {
    let reads = 0;
    const control = new SurfaceControl(
      {
        publish: async () => undefined,
        history: async () => {
          reads += 1;
          if (reads === 1) throw new Error('journal unreadable');
          return [];
        },
      },
      { now: () => 1 },
    );
    await expect(control.view(SESSION, 'terminal')).rejects.toThrow('journal unreadable');
    expect((await control.view(SESSION, 'terminal')).takeovers).toEqual([]);
    expect(reads).toBe(2);
  });

  it('takes a surface over once, and a second takeover returns the one that stands', async () => {
    const w = world();
    const target = { surface: 'terminal' as const, id: 't-1', name: 'dev' };
    const first = await w.control.takeover(SESSION, target, { by: 'local' });
    const second = await w.control.takeover(SESSION, target, { by: 'human', deviceId: 'phone' });
    expect(second).toEqual(first);
    expect(w.published.filter(e => e.type === 'surface.takeover')).toHaveLength(1);
    await w.control.handback(SESSION, target);
    await w.control.handback(SESSION, target);
    expect(w.published.filter(e => e.type === 'surface.handback')).toHaveLength(1);
    await w.control.hand(SESSION, target, { by: 'local' });
    await w.control.hand(SESSION, target, { by: 'local' });
    expect(w.published.filter(e => e.type === 'surface.handed')).toHaveLength(1);
  });

  it('keeps its driving marker for half its window before it publishes a fresh one', async () => {
    const w = world();
    const target = { surface: 'terminal' as const, id: 't-1' };
    await w.control.drove(SESSION, target, {});
    await w.control.drove(SESSION, target, {});
    expect(w.published).toHaveLength(1);
    w.advance(10_000);
    await w.control.drove(SESSION, target, {});
    expect(w.published).toHaveLength(2);
    w.advance(60_000);
    expect((await w.control.view(SESSION, 'terminal')).driving).toEqual([]);
  });
});
