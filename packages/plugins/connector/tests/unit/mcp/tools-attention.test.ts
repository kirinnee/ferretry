import { describe, it } from 'bun:test';
import should from 'should';
import { ATTENTION_READ_CAP, cutAtLine, shares } from '../../../daemon/lib/mcp/agenda-read.ts';
import { CONNECTOR_TOOLS } from '../../../daemon/lib/mcp/tools/index.ts';
import { agendaItem, ok, READ_ACCESS, ferretView } from '../../support/mcp-fixtures.ts';
import { rig, tool } from '../../support/mcp-harness.ts';

/** `get_attention`: one agenda item read in full, the tabs included, under a cap, with secrets masked. */

const LIZ = ferretView({
  id: 'mwuanehg-4531fa9e',
  callsign: 'lizzette',
  task: '[Lizzette] Build MCP Connector',
  state: 'working',
});
const MARIN = ferretView({
  id: 'mxk2aa11-0001ffff',
  callsign: 'marin',
  task: 'Fix the login page',
  state: 'idle',
});

const TABLE = ['| Option | Cost |', '| --- | --- |', '| Postgres | high |', '| SQLite | low |'].join('\n');

type Item = ReturnType<typeof agendaItem>;
const world = (
  items: Item[],
  options: { redact?: (text: string) => Promise<string>; also?: [string, Item[]][] } = {},
) => {
  const r = rig(options.redact === undefined ? {} : { redact: options.redact });
  r.state.access = READ_ACCESS;
  r.delegate
    .on(call => (call.method === 'GET' && call.path === '/v1/ferrets' ? ok([LIZ, MARIN]) : undefined))
    .on(call =>
      call.path === '/v1/agenda/open'
        ? ok({
            sessions: [
              ...(items.length === 0 ? [] : [{ sessionId: LIZ.id, items }]),
              ...(options.also ?? []).map(([sessionId, rest]) => ({ sessionId, items: rest })),
            ],
          })
        : undefined,
    );
  return r;
};

const full = (extra: Record<string, unknown> = {}): Item =>
  agendaItem({
    id: 'A12',
    subject: 'Pick a database',
    why: 'Which database should the connector use?',
    ask: { kind: 'multiple-choice', options: [{ label: 'Postgres', description: 'Heavier' }, { label: 'SQLite' }] },
    extra: {
      title: 'Database choice',
      premise: '- The connector stores grants',
      context: 'Grants must survive a restart.',
      recommendation: { decision: 'SQLite', why: 'No server to run' },
      optionDetails: [{ label: 'SQLite', detail: 'A single file.\n\nNo daemon.' }],
      steps: ['Read the table', 'Pick one'],
      stepsDone: [0],
      links: [{ label: 'PR', target: 'https://github.com/o/r/pull/1', meaning: 'the work' }],
      whereWeAre: 'Two options are on the table.',
      decided: '- Keep it local',
      stillOpen: '- Which one',
      body: 'The full picture.',
      tabs: [{ id: 'costs', name: 'Costs', body: `Costs compared:\n\n${TABLE}` }],
      ...extra,
    },
  });

describe('get_attention — the whole item', () => {
  it('says who, what state, the question, each option, the recommendation, the steps, links and every tab', async () => {
    const r = world([full()]);
    const reply = await tool(r, 'get_attention', { item: 'A12' });
    should(reply.isError).be.false();
    const text = reply.text;
    should(text.split('\n')[0]).equal('!A12 — Database choice — from Lizzette');
    should(text).containEql('Sections: Overview; Context; Where we are now; The full picture; Costs');
    for (const said of [
      'Raised by: Lizzette',
      'State: open, waiting for you. Kind: choice.',
      'The question: Which database should the connector use?',
      '- Postgres — Heavier',
      '- SQLite',
      '    A single file.',
      'Recommended: SQLite — No server to run',
      'Premise:',
      '1. [x] Read the table',
      '2. [ ] Pick one',
      '- PR: https://github.com/o/r/pull/1 — the work',
      '## Context\nGrants must survive a restart.',
      '## Where we are now',
      'Decided:\n- Keep it local',
      'Still open:\n- Which one',
      'Two options are on the table.',
      '## The full picture\nThe full picture.',
      '## Costs',
    ])
      should(text).containEql(said);
    should(text).not.containEql('Clipped');
  });

  it('keeps a markdown table a table, byte for byte', async () => {
    const r = world([full()]);
    should((await tool(r, 'get_attention', { item: 'A12' })).text).containEql(`Costs compared:\n\n${TABLE}`);
  });

  it('reads the owner’s earlier replies: the latest answer and the thread', async () => {
    const item = full({
      ownerAnswer: {
        at: '2026-11-24T11:30:00.000Z',
        response: { kind: 'multiple-choice', choice: 'SQLite' },
        note: 'cheap',
        request: 1,
      },
      conversation: [
        { at: '2026-11-24T11:10:00.000Z', by: 'owner', via: 'reply', text: 'Why not Postgres?' },
        { at: '2026-11-24T11:20:00.000Z', by: 'ferret', via: 'question-answer', text: 'It needs a server.' },
      ],
    });
    const text = (await tool(world([item]), 'get_attention', { item: '!a12' })).text;
    should(text).containEql('Latest answer from the owner (30 min ago): chose "SQLite" — note: cheap');
    should(text).containEql('[owner, reply, 50 min ago] Why not Postgres?');
    should(text).containEql('[ferret, question-answer, 40 min ago] It needs a server.');
  });

  it('accepts "A12", "!A12", "a 12" and "12" alike, and a title when it is unambiguous', async () => {
    const r = world([full()]);
    for (const spoken of ['A12', '!A12', 'a 12', '12', 'database choice'])
      should((await tool(r, 'get_attention', { item: spoken })).text.split('\n')[0]).equal(
        '!A12 — Database choice — from Lizzette',
      );
  });

  it('says only the app can answer an item that needs a passkey, and still reads it', async () => {
    const item = agendaItem({
      id: 'A20',
      subject: 'Fill in a form',
      why: 'What is the name?',
      kind: 'form',
      ask: { kind: 'open-question' },
      extra: { fields: [{ id: '1', type: 'text', label: 'The name' }] },
    });
    const reply = await tool(world([item]), 'get_attention', { item: 'A20' });
    should(reply.isError).be.false();
    should(reply.text).containEql('Only the Ferretry app can answer this one');
    should(reply.text).containEql('Form field 1 (text): The name');
  });

  it('reads a parked item too (list_attention hides it; reading is harmless) and names its state', async () => {
    const item = full({
      parked: { reason: 'snoozed', at: '2026-11-24T11:00:00.000Z', until: '2026-11-25T11:00:00.000Z' },
    });
    const reply = await tool(world([item]), 'get_attention', { item: 'A12' });
    should(reply.text).containEql('State: snoozed until 2026-11-25T11:00:00.000Z.');
  });

  it('makes no request but the two reads list_attention makes, and is not logged as a write', async () => {
    const r = world([full()]);
    await tool(r, 'get_attention', { item: 'A12' });
    should(r.delegate.calls.map(entry => `${entry.call.method} ${entry.call.path}`).sort()).eql([
      'GET /v1/agenda/open',
      'GET /v1/ferrets',
      'GET /v1/machine/agenda',
    ]);
    should(r.calls.records.length).equal(0);
    should(r.audit.events.length).equal(0);
  });
});

describe('get_attention — the size cap', () => {
  const long = (mark: string, n: number): string =>
    Array.from({ length: n }, (_, index) => `${mark} line ${index} of the tab`).join('\n');

  it('shares the room: a short tab is whole, long ones each show their start, and the answer names what was cut', async () => {
    const item = full({
      tabs: [
        { id: 'first', name: 'First', body: long('F', 4000) },
        { id: 'short', name: 'Short', body: 'tiny tab' },
        { id: 'last', name: 'Last', body: long('L', 4000) },
      ],
    });
    const text = (await tool(world([item]), 'get_attention', { item: 'A12' })).text;
    should(text.length).be.belowOrEqual(ATTENTION_READ_CAP);
    should(text).containEql('Clipped to fit one answer. Cut: First; Last.');
    should(text).containEql('## Short\ntiny tab');
    should(text).containEql('F line 0 of the tab');
    should(text).containEql('L line 0 of the tab');
    should(text).containEql('Call get_attention again with tab "First" to read it whole.');
    should(text).containEql('Call get_attention again with tab "Last" to read it whole.');
    should(text).not.containEql('## Short\ntiny tab\n[… cut');
    // Everything that is short enough stays whole: the overview and the full picture are not cut.
    should(text).containEql('## The full picture\nThe full picture.');
    should(text).containEql('2. [ ] Pick one');
  });

  it('fetches one tab in full with `tab`, by name in any case or by id, still capped', async () => {
    const r = world([full({ tabs: [{ id: 'first', name: 'First', body: long('F', 600) }] })]);
    const byName = await tool(r, 'get_attention', { item: 'A12', tab: 'FIRST' });
    should(byName.text).containEql('F line 599 of the tab');
    should(byName.text).not.containEql('cut');
    should(byName.text).not.containEql('Clipped');
    const byId = await tool(r, 'get_attention', { item: 'A12', tab: 'first' });
    should(byId.text).equal(byName.text);
  });

  it('walks a tab bigger than the cap with `from`, so nothing is out of reach', async () => {
    const body = long('B', 5000);
    const r = world([full({ tabs: [{ id: 'big', name: 'Big', body }] })]);
    let from = 0;
    let rebuilt = '';
    for (let round = 0; round < 10; round += 1) {
      const reply = await tool(r, 'get_attention', { item: 'A12', tab: 'Big', from });
      should(reply.isError).be.false();
      should(reply.text.length).be.belowOrEqual(ATTENTION_READ_CAP);
      const piece = reply.text.split('\n').slice(2).join('\n');
      const next = /and from (\d+) to continue/u.exec(reply.text);
      rebuilt += next === null ? piece : piece.slice(0, piece.lastIndexOf('\n[… '));
      if (next === null) break;
      from = Number(next[1]);
    }
    should(rebuilt).equal(body);
  });

  it('says so when `from` is past the end, and refuses `from` without `tab`', async () => {
    const r = world([full()]);
    should((await tool(r, 'get_attention', { item: 'A12', tab: 'costs', from: 99_999 })).text).containEql(
      'past the end',
    );
    const bad = await tool(r, 'get_attention', { item: 'A12', from: 3 });
    should(bad.isError).be.true();
    should(bad.text).containEql('"from" goes with "tab"');
  });

  it('names the sections when `tab` matches none, and reads the item’s own parts by name', async () => {
    const r = world([full()]);
    const none = await tool(r, 'get_attention', { item: 'A12', tab: 'nope' });
    should(none.isError).be.true();
    should(none.text).containEql('Item A12 has no section "nope". Its sections: Overview; Context; Where we are now;');
    should((await tool(r, 'get_attention', { item: 'A12', tab: 'context' })).text).containEql(
      'Grants must survive a restart.',
    );
  });

  it('keeps an item’s own tab called "Context" apart from the item’s context', async () => {
    const r = world([full({ tabs: [{ id: 'context', name: 'Context', body: 'The tab.' }] })]);
    should((await tool(r, 'get_attention', { item: 'A12', tab: 'Context' })).text).containEql('The tab.');
    should((await tool(r, 'get_attention', { item: 'A12', tab: 'Context (item)' })).text).containEql(
      'Grants must survive a restart.',
    );
  });
});

describe('get_attention — secrets', () => {
  it('masks a planted secret in a tab and in the context, whatever redaction the vault does', async () => {
    const item = full({
      context: 'Use the key sk-ant-ABCDEFGH12345678 for it.',
      tabs: [
        {
          id: 'notes',
          name: 'Notes',
          body: `| key | value |\n| --- | --- |\n| db | password=hunter2hunter2 |\n\nVault: s3cr3t-vault-value`,
        },
      ],
    });
    const redact = async (text: string) => text.replaceAll('s3cr3t-vault-value', '[redacted]');
    const reply = await tool(world([item], { redact }), 'get_attention', { item: 'A12' });
    should(reply.text).not.containEql('sk-ant-ABCDEFGH12345678');
    should(reply.text).not.containEql('hunter2hunter2');
    should(reply.text).not.containEql('s3cr3t-vault-value');
    should(reply.text).containEql('| db | password=[redacted] |');
    const tabOnly = await tool(world([item], { redact }), 'get_attention', { item: 'A12', tab: 'Notes' });
    should(tabOnly.text).not.containEql('hunter2hunter2');
  });

  it('masks a secret in the title, the question, an option, a step and a link', async () => {
    const item = full({
      title: 'Use token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      steps: ['Run with Bearer abcdefghijklmnopqrstuv'],
      links: [{ label: 'x', target: 'https://user:pw123@example.com/a' }],
    });
    const reply = await tool(world([item]), 'get_attention', { item: 'A12' });
    should(reply.text).not.containEql('ghp_abcdefghij');
    should(reply.text).not.containEql('abcdefghijklmnopqrstuv');
    should(reply.text).not.containEql('pw123');
  });

  it('withholds a section it cannot clean, not the raw text, and still returns the others', async () => {
    const redact = async (text: string) => {
      if (text.includes('The full picture.')) throw new Error('vault closed');
      return text;
    };
    const reply = await tool(world([full()], { redact }), 'get_attention', { item: 'A12' });
    should(reply.text).containEql('## The full picture\n[output withheld]');
    should(reply.text).containEql('## Costs');
  });

  it('never cuts a credential in half: it is masked before the cut', async () => {
    const secret = 'sk-ant-ZZZZZZZZZZZZZZZZZZZZZZ';
    const filler = Array.from({ length: 4000 }, (_, index) => `row ${index}`).join('\n');
    const item = full({ tabs: [{ id: 'big', name: 'Big', body: `${filler}\nkey ${secret}\n${filler}` }] });
    const text = (await tool(world([item]), 'get_attention', { item: 'A12', tab: 'Big', from: 0 })).text;
    should(text).not.containEql('sk-ant-');
    should(text).not.containEql('ZZZZZZ');
  });
});

describe('get_attention — an id that is not there', () => {
  it('says so in a plain sentence with the near ids', async () => {
    const other = agendaItem({ id: 'A21', subject: 'Other', why: 'Other?', extra: { title: 'Other thing' } });
    const reply = await tool(world([full(), other]), 'get_attention', { item: 'A22' });
    should(reply.isError).be.true();
    should(reply.text).equal('There is no open item A22. Did you mean !A12 (Database choice), or !A21 (Other thing)?');
  });

  it('lists what is open when nothing is near, and says when nothing is waiting', async () => {
    const reply = await tool(world([full()]), 'get_attention', { item: 'A900' });
    should(reply.text).equal('There is no open item A900. Open items: !A12.');
    should((await tool(world([]), 'get_attention', { item: 'A1' })).text).equal(
      'There is no open item A1. Nothing is waiting on you.',
    );
  });

  it('says what is wrong with a word that is neither an id nor a title, and offers titles near it', async () => {
    const reply = await tool(world([full()]), 'get_attention', { item: 'zzzz' });
    should(reply.isError).be.true();
    should(reply.text).containEql('"zzzz" is not an item id (they look like A12) and no title matches it.');
    const near = await tool(world([full()]), 'get_attention', { item: 'databse choice' });
    should(near.text).containEql('Did you mean !A12 (Database choice)?');
  });

  it('asks which ferret when two have an item with the same id, and `ferret` settles it', async () => {
    const mine = full();
    const theirs = agendaItem({
      id: 'A12',
      subject: 'Marin’s question',
      why: 'Marin asks?',
      raisedBySession: MARIN.id,
      extra: { title: 'Login question' },
    });
    const r = world([mine], { also: [[MARIN.id, [theirs]]] });
    const both = await tool(r, 'get_attention', { item: 'A12' });
    should(both.isError).be.true();
    should(both.text).equal('Item A12 is open for more than one ferret (Lizzette and Marin). Which ferret asked?');
    should((await tool(r, 'get_attention', { item: 'A12', ferret: 'marin' })).text.split('\n')[0]).equal(
      '!A12 — Login question — from Marin',
    );
    should((await tool(r, 'get_attention', { item: 'A12', ferret: 'lizzette' })).text.split('\n')[0]).equal(
      '!A12 — Database choice — from Lizzette',
    );
  });

  it('does not show a typed-value (input) item, as list_attention does not list it', async () => {
    const input = agendaItem({
      id: 'A30',
      subject: 'Type a value',
      why: 'Value?',
      kind: 'input',
      extra: { input: { requestId: '0123456789abcdef0123456789abcdef' } },
    });
    const reply = await tool(world([input]), 'get_attention', { item: 'A30' });
    should(reply.isError).be.true();
    should(reply.text).startWith('There is no open item A30.');
  });
});

describe('get_attention and list_attention agree', () => {
  it('list_attention says to call get_attention, and every id it prints is readable', async () => {
    const r = world([
      full(),
      agendaItem({ id: 'A13', subject: 'Looks good?', why: 'Review the plan', ask: { kind: 'answer-review' } }),
    ]);
    const listed = (await tool(r, 'list_attention', {})).text;
    const ids = [...listed.matchAll(/^!(A\d+) /gmu)].map(match => match[1] as string);
    should(ids).eql(['A12', 'A13']);
    for (const id of ids) should((await tool(r, 'get_attention', { item: `!${id}` })).isError).be.false();
    const description = (CONNECTOR_TOOLS.find(spec => spec.name === 'list_attention') as { description: string })
      .description;
    should(description).containEql('get_attention');
  });
});

describe('the budget, as pure parts', () => {
  it('shares: whole when it fits, else the water level, never above the room', () => {
    should(shares([5, 10], 100)).eql([5, 10]);
    should(shares([10, 100, 100], 130)).eql([10, 60, 60]);
    should(shares([100, 100], 50)).eql([25, 25]);
    should(shares([], 10)).eql([]);
    should(shares([50], 0)).eql([0]);
  });

  it('cuts at a line break when one is near, so a table row is not cut in half', () => {
    should(cutAtLine('abc\ndef\nghi', 9)).equal('abc\ndef');
    should(cutAtLine('abcdef\nxyz', 4)).equal('abcd');
    should(cutAtLine('short', 50)).equal('short');
  });
});

describe('get_attention — a title, read loosely, and the ferret that is named', () => {
  const marins = (title: string) =>
    agendaItem({
      id: 'A40',
      subject: 'Marin asks',
      why: 'Marin?',
      raisedBySession: MARIN.id,
      extra: { title },
    });

  it('asks which one when a part of a title fits two items', async () => {
    const other = agendaItem({ id: 'A21', subject: 'Other', why: 'Other?', extra: { title: 'Database backup' } });
    const reply = await tool(world([full(), other]), 'get_attention', { item: 'database' });
    should(reply.isError).be.true();
    should(reply.text).equal(
      'More than one item matches "database": !A12 (Database choice); !A21 (Database backup). Which one?',
    );
  });

  it('applies the ferret it is given before it matches a title, so the other ferret’s item cannot answer', async () => {
    const r = world([full()], { also: [[MARIN.id, [marins('Database backup')]]] });
    const unqualified = await tool(r, 'get_attention', { item: 'database' });
    should(unqualified.text).containEql('More than one item matches');
    should((await tool(r, 'get_attention', { item: 'database', ferret: 'marin' })).text.split('\n')[0]).equal(
      '!A40 — Database backup — from Marin',
    );
    should((await tool(r, 'get_attention', { item: 'database', ferret: 'lizzette' })).text.split('\n')[0]).equal(
      '!A12 — Database choice — from Lizzette',
    );
  });

  it('says so when the ferret it names has no open items, and never reads another’s by title', async () => {
    const reply = await tool(world([full()]), 'get_attention', { item: 'database', ferret: 'marin' });
    should(reply.isError).be.true();
    should(reply.text).equal('Marin has no open items.');
  });
});

describe('get_attention — a credential at the cutoff of the heading', () => {
  it('cleans the whole title before it is cut, so no fragment is left', async () => {
    const key = `sk-${'Q'.repeat(30)}`;
    const item = agendaItem({ id: 'A5', subject: `${'a'.repeat(110)} ${key}`, why: 'Why?' });
    const redact = async (text: string) => text.replace(/sk-[A-Za-z0-9]{20,}/gu, '[redacted]');
    const first = (await tool(world([item], { redact }), 'get_attention', { item: 'A5' })).text.split('\n')[0];
    should(first).not.containEql('sk-');
    should(first).containEql('[redacte…');
  });
});
