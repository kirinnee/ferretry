import { describe, it } from 'bun:test';
import should from 'should';
import {
  OWNER_ZONE,
  pacificWords,
  parseSnoozeDuration,
  parseSnoozeUntil,
} from '../../../../src/lib/connector/mcp/snooze-time.ts';
import type { AgendaItem } from '@ferretry/protocol';
import {
  agendaItem,
  NOW,
  ok,
  READ_ACCESS,
  refuse,
  sessionView,
  snapshot,
} from '../../../support/connector/mcp-fixtures.ts';
import { rig, tool } from '../../../support/connector/mcp-harness.ts';

/** `snooze_attention`: the daemon's own snooze, said in Pacific time, bounded, and listed again afterwards. */

const LIZ = sessionView({
  id: 'mwuanehg-4531fa9e',
  callsign: 'lizzette',
  task: '[Lizzette] Build',
  turnState: 'working',
});
const MARIN = sessionView({
  id: 'mxk2aa11-0001ffff',
  callsign: 'marin',
  task: 'Fix the login page',
  turnState: 'your-turn',
});

/** A fake daemon whose board remembers a snooze and whose timer can be moved, as the real one does. */
function world(items: AgendaItem[], options: { also?: [string, AgendaItem[]][] } = {}) {
  const r = rig();
  const boards = new Map<string, AgendaItem[]>([[LIZ.config.id, items], ...(options.also ?? [])]);
  const bodies: { path: string; body: Record<string, unknown> }[] = [];
  r.dispatch
    .on(call => (call.method === 'GET' && call.path === '/v1/sessions' ? ok([LIZ, MARIN]) : undefined))
    .on(call =>
      call.path === '/v1/agenda/open'
        ? ok({
            sessions: [...boards]
              .filter(([, list]) => list.length > 0)
              .map(([sessionId, list]) => ({ sessionId, items: list })),
          })
        : undefined,
    )
    .on(call => {
      if (call.method !== 'POST' || !call.path.endsWith('/agenda')) return undefined;
      const body = call.body as { action: string; id: string; until: string };
      bodies.push({ path: call.path, body });
      const sessionId = decodeURIComponent(call.path.split('/')[3] as string);
      const list = boards.get(sessionId) ?? [];
      boards.set(
        sessionId,
        list.map(entry =>
          entry.id === body.id
            ? ({
                ...entry,
                parked: { reason: 'snoozed', at: new Date(r.state.now).toISOString(), until: body.until },
              } as AgendaItem)
            : entry,
        ),
      );
      return ok(snapshot(sessionId));
    });
  return { r, bodies };
}

const a12 = (extra: Record<string, unknown> = {}) =>
  agendaItem({
    id: 'A12',
    subject: 'Close OCBC 365 card',
    why: 'Did you close it?',
    kind: 'task',
    ask: { kind: 'task' },
    extra: { title: 'Today: close OCBC 365 card', ...extra },
  });

describe('the time words', () => {
  // NOW is 2026-11-24T12:00:00Z = 04:00 PST (UTC-8).
  it('reads a time with no zone as Pacific, with daylight saving', () => {
    should(parseSnoozeUntil('2026-11-25T09:00', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T17:00:00Z') });
    should(parseSnoozeUntil('2026-07-01T09:00', NOW)).eql({ ok: true, at: Date.parse('2026-07-01T16:00:00Z') });
    should(parseSnoozeUntil('2026-11-25 09:30:15', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T17:30:15Z') });
    should(parseSnoozeUntil('2026-11-25', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T17:00:00Z') });
  });

  it('keeps a zone it is given', () => {
    should(parseSnoozeUntil('2026-11-25T09:00:00Z', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T09:00:00Z') });
    should(parseSnoozeUntil('2026-11-25T09:00:00+08:00', NOW)).eql({
      ok: true,
      at: Date.parse('2026-11-25T01:00:00Z'),
    });
    should(parseSnoozeUntil('2026-11-25T09:00:00-0500', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T14:00:00Z') });
  });

  it('reads a clock time as its next occurrence in Pacific, and today or tomorrow with one', () => {
    should(parseSnoozeUntil('17:00', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T01:00:00Z') });
    should(parseSnoozeUntil('3am', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T11:00:00Z') });
    should(parseSnoozeUntil('tomorrow 9am', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T17:00:00Z') });
    should(parseSnoozeUntil('Tomorrow at 9:30 PM', NOW)).eql({ ok: true, at: Date.parse('2026-11-26T05:30:00Z') });
    should(parseSnoozeUntil('today 5pm', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T01:00:00Z') });
    should(parseSnoozeUntil('12am', NOW)).eql({ ok: true, at: Date.parse('2026-11-25T08:00:00Z') });
  });

  it('refuses what it cannot read, with the forms on offer, rather than guess', () => {
    for (const bad of ['soon', '2026-02-30T09:00', '2026-11-25T25:00', '13pm', '0am', 'next week']) {
      const parsed = parseSnoozeUntil(bad, NOW);
      should(parsed.ok).be.false();
      if (!parsed.ok) should(parsed.problem).containEql(`"${bad}" is not a time I can read. Use an ISO time`);
    }
  });

  it('reads waits: 90m, 2h, 1d, 1d 2h, "in 3h", words and weeks', () => {
    const at = (text: string) => parseSnoozeDuration(text, NOW);
    should(at('90m')).eql({ ok: true, at: NOW + 90 * 60_000 });
    should(at('2h')).eql({ ok: true, at: NOW + 2 * 3_600_000 });
    should(at('1d')).eql({ ok: true, at: NOW + 86_400_000 });
    should(at('1d 2h')).eql({ ok: true, at: NOW + 86_400_000 + 2 * 3_600_000 });
    should(at('in 3 hours')).eql({ ok: true, at: NOW + 3 * 3_600_000 });
    should(at('1.5h')).eql({ ok: true, at: NOW + 5_400_000 });
    should(at('2 weeks')).eql({ ok: true, at: NOW + 14 * 86_400_000 });
    for (const bad of ['soon', '0m', '5 parsecs', 'h', '']) should(at(bad).ok).be.false();
  });

  it('says a wake time in Pacific, standard or daylight', () => {
    should(OWNER_ZONE).equal('America/Los_Angeles');
    should(pacificWords(Date.parse('2026-11-25T17:00:00Z'))).equal('Wed, Nov 25, 9:00 AM PST');
    should(pacificWords(Date.parse('2026-07-01T16:00:00Z'))).equal('Wed, Jul 1, 9:00 AM PDT');
  });
});

describe('snooze_attention', () => {
  it('snoozes through the daemon’s own agenda route and says the wake time in Pacific', async () => {
    const { r, bodies } = world([a12()]);
    const reply = await tool(r, 'snooze_attention', { item: 'A12', until: '2026-11-25T09:00' });
    should(reply.isError).be.false();
    should(reply.text).startWith('Snoozed !A12 (Today: close OCBC 365 card) until Wed, Nov 25, 9:00 AM PST (in 29 h).');
    should(bodies).eql([
      {
        path: `/v1/sessions/${LIZ.config.id}/agenda`,
        body: { action: 'snooze', id: 'A12', until: '2026-11-25T17:00:00.000Z' },
      },
    ]);
  });

  it('takes a duration, and accepts the id as "!A12", "a 12" or "12"', async () => {
    for (const spoken of ['!A12', 'a 12', '12']) {
      const { r, bodies } = world([a12()]);
      const reply = await tool(r, 'snooze_attention', { item: spoken, duration: '2h' });
      should(reply.text).containEql('until Tue, Nov 24, 6:00 AM PST (in 2 h)');
      should((bodies[0]?.body as { until: string } | undefined)?.until).equal('2026-11-24T14:00:00.000Z');
    }
  });

  it('needs exactly one of until and duration', async () => {
    const { r, bodies } = world([a12()]);
    for (const args of [{ item: 'A12' }, { item: 'A12', until: '17:00', duration: '2h' }]) {
      const reply = await tool(r, 'snooze_attention', args);
      should(reply.isError).be.true();
      should(reply.text).containEql('exactly one of until (a time) or duration');
    }
    should(bodies.length).equal(0);
  });

  it('keeps the snooze in bounds: at least a minute ahead, at most 30 days', async () => {
    const { r, bodies } = world([a12()]);
    const past = await tool(r, 'snooze_attention', { item: 'A12', until: '2026-11-24T03:00' });
    should(past.text).containEql('not in the future');
    const soon = await tool(r, 'snooze_attention', { item: 'A12', duration: '30s' });
    should(soon.isError).be.true();
    const tooSoon = await tool(r, 'snooze_attention', { item: 'A12', until: '2026-11-24T04:00:30' });
    should(tooSoon.text).containEql('less than a minute ahead');
    const far = await tool(r, 'snooze_attention', { item: 'A12', duration: '31d' });
    should(far.text).containEql('more than 30 days away');
    should(far.text).containEql('The latest I can snooze to is Thu, Dec 24, 4:00 AM PST.');
    const edge = await tool(r, 'snooze_attention', { item: 'A12', duration: '30d' });
    should(edge.isError).be.false();
    should(bodies.length).equal(1);
  });

  it('says what it could not read, and what to use', async () => {
    const { r, bodies } = world([a12()]);
    const reply = await tool(r, 'snooze_attention', { item: 'A12', until: 'whenever' });
    should(reply.isError).be.true();
    should(reply.text).containEql('"whenever" is not a time I can read.');
    should(bodies.length).equal(0);
  });

  it('is hidden from list_attention until its time, and listed again after — the clock moved', async () => {
    const { r } = world([a12()]);
    should((await tool(r, 'list_attention', {})).text).containEql('1 waiting on you:');
    await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
    should((await tool(r, 'list_attention', {})).text).equal('Nothing is waiting on you.');
    const shown = (await tool(r, 'list_attention', { snoozed: true })).text;
    should(shown).containEql('Nothing is waiting on you right now.');
    should(shown).containEql('1 snoozed:');
    should(shown).containEql('(snoozed until Tue, Nov 24, 6:00 AM PST)');
    r.state.now = NOW + 2 * 3_600_000 - 1;
    should((await tool(r, 'list_attention', {})).text).equal('Nothing is waiting on you.');
    r.state.now = NOW + 2 * 3_600_000;
    const back = (await tool(r, 'list_attention', {})).text;
    should(back).containEql('1 waiting on you:');
    should(back).containEql('!A12');
    should(back).not.containEql('snoozed');
  });

  it('snoozes again, and says it replaced the first', async () => {
    const { r } = world([a12()]);
    await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
    const again = await tool(r, 'snooze_attention', { item: 'A12', duration: '1d' });
    should(again.text).containEql('It was snoozed until Tue, Nov 24, 6:00 AM PST; this replaces that.');
  });

  it('leaves an item waiting on its ferret alone, and an unknown id with the near ids', async () => {
    const resting = a12({ parked: { reason: 'replied', at: '2026-11-24T11:00:00.000Z' } });
    const { r, bodies } = world([resting]);
    const reply = await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
    should(reply.isError).be.true();
    should(reply.text).containEql('is waiting on its ferret, not on you, so there is nothing to snooze.');
    const missing = await tool(r, 'snooze_attention', { item: 'A99', duration: '2h' });
    should(missing.text).containEql('There is no open item A99.');
    should(bodies.length).equal(0);
  });

  it('asks which ferret when two share an id, and `ferret` settles it', async () => {
    const theirs = agendaItem({ id: 'A12', subject: 'Marin asks', why: 'Marin?', raisedBySession: MARIN.config.id });
    const { r, bodies } = world([a12()], { also: [[MARIN.config.id, [theirs]]] });
    const both = await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
    should(both.text).equal('Item A12 is open for more than one ferret (Lizzette and Marin). Which ferret asked?');
    await tool(r, 'snooze_attention', { item: 'A12', duration: '2h', ferret: 'marin' });
    should(bodies.map(entry => entry.path)).eql([`/v1/sessions/${MARIN.config.id}/agenda`]);
  });

  it('says the daemon’s own words when it refuses, and logs the refusal', async () => {
    const r = rig();
    r.dispatch
      .on(call => (call.path === '/v1/sessions' ? ok([LIZ]) : undefined))
      .on(call =>
        call.path === '/v1/agenda/open' ? ok({ sessions: [{ sessionId: LIZ.config.id, items: [a12()] }] }) : undefined,
      )
      .on(call => (call.method === 'POST' ? refuse(409, 'a notice is read, not snoozed') : undefined));
    const reply = await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
    should(reply.isError).be.true();
    should(reply.text).equal('a notice is read, not snoozed');
    should(r.calls.records.map(entry => [entry.tool, entry.outcome])).eql([['snooze_attention', 'error']]);
    should(r.audit.events).eql([
      {
        kind: 'connector.tool',
        grantId: 'cg_aaaaaaaaaa',
        tool: 'snooze_attention',
        sessionId: LIZ.config.id,
        outcome: 'error',
      },
    ]);
  });

  it('is audited as a write, with its arguments and the ferret it touched', async () => {
    const { r } = world([a12()]);
    await tool(r, 'snooze_attention', { item: 'A12', until: 'tomorrow 9am' });
    should(r.calls.records.map(entry => [entry.tool, entry.outcome, entry.args])).eql([
      ['snooze_attention', 'ok', { item: 'A12', until: 'tomorrow 9am' }],
    ]);
    should(
      r.audit.events.map(entry => [
        entry.kind,
        (entry as { tool: string }).tool,
        (entry as { sessionId?: string }).sessionId,
      ]),
    ).eql([['connector.tool', 'snooze_attention', LIZ.config.id]]);
  });

  it('is refused to a read-only token before it reaches the daemon', async () => {
    const { r, bodies } = world([a12()]);
    r.state.access = READ_ACCESS;
    const reply = await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
    should(reply.isError).be.true();
    should(reply.text).containEql('only look');
    should(bodies.length).equal(0);
  });
});
