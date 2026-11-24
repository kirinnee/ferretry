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
function world(
  items: AgendaItem[],
  options: { also?: [string, AgendaItem[]][]; redact?: (text: string) => Promise<string> } = {},
) {
  const r = rig(options.redact === undefined ? {} : { redact: options.redact });
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

describe('snooze_attention — the time words, at the edges of the calendar', () => {
  it('refuses a zoned date that is not on the calendar instead of rolling it to March', () => {
    for (const bad of ['2026-02-29T09:00:00Z', '2026-04-31T09:00:00+08:00', '2026-11-25T24:00:00Z']) {
      const parsed = parseSnoozeUntil(bad, NOW);
      should(parsed.ok).be.false();
      if (!parsed.ok) should(parsed.problem).containEql(`"${bad}" is not a time I can read.`);
    }
    should(parseSnoozeUntil('2028-02-29T09:00:00Z', NOW)).eql({ ok: true, at: Date.parse('2028-02-29T09:00:00Z') });
  });

  it('refuses a time the clocks skip (02:30 on the day daylight saving starts) rather than moving it an hour', () => {
    const parsed = parseSnoozeUntil('2026-03-08T02:30', NOW);
    should(parsed.ok).be.false();
    if (!parsed.ok) should(parsed.problem).containEql('does not exist in Pacific time (the clocks skip it that day)');
    // Either side of the gap is fine.
    should(parseSnoozeUntil('2026-03-08T01:59', NOW)).eql({ ok: true, at: Date.parse('2026-03-08T09:59:00Z') });
    should(parseSnoozeUntil('2026-03-08T03:00', NOW)).eql({ ok: true, at: Date.parse('2026-03-08T10:00:00Z') });
  });

  it('refuses a skipped time said as a clock time, with today or tomorrow, or as the next occurrence', () => {
    const night = Date.parse('2026-03-08T08:00:00Z'); // 00:00 PST on the day the clocks jump
    const evening = Date.parse('2026-03-07T20:00:00Z'); // noon PST the day before
    for (const [text, now] of [
      ['2:30am', night],
      ['today 2:30am', night],
      ['tomorrow 2:30am', evening],
      ['2:30am', evening],
    ] as const) {
      const parsed = parseSnoozeUntil(text, now);
      should(parsed.ok).be.false();
      if (!parsed.ok) should(parsed.problem).containEql('does not exist in Pacific time');
    }
    should(parseSnoozeUntil('3am', night)).eql({ ok: true, at: Date.parse('2026-03-08T10:00:00Z') });
  });
});

describe('snooze_attention — a deadline wakes it sooner', () => {
  it('says the deadline, not the time asked for, when the item is needed by before then', async () => {
    const { r, bodies } = world([a12({ neededBy: '2026-11-24T12:15:00.000Z' })]);
    const reply = await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
    should(reply.isError).be.false();
    should(reply.text).startWith(
      'Snoozed !A12 (Today: close OCBC 365 card) until Tue, Nov 24, 4:15 AM PST (in 15 min).',
    );
    should(reply.text).containEql(
      'That is sooner than the Tue, Nov 24, 6:00 AM PST you asked for, because it is needed by Tue, Nov 24, 4:15 AM PST.',
    );
    should((bodies[0]?.body as { until: string } | undefined)?.until).equal('2026-11-24T14:00:00.000Z');
  });

  it('says the daemon wakes it at once when the deadline has already passed', async () => {
    const { r } = world([a12({ neededBy: '2026-11-24T11:00:00.000Z' })]);
    const reply = await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
    should(reply.isError).be.false();
    should(reply.text).containEql('it was needed by Tue, Nov 24, 3:00 AM PST, which has passed');
    should(reply.text).containEql('wakes it again at once');
    should(reply.text).not.containEql('(in ');
  });

  it('keeps the time asked for when the deadline is later', async () => {
    const { r } = world([a12({ neededBy: '2026-12-01T12:00:00.000Z' })]);
    const reply = await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
    should(reply.text).startWith('Snoozed !A12 (Today: close OCBC 365 card) until Tue, Nov 24, 6:00 AM PST (in 2 h).');
    should(reply.text).not.containEql('sooner');
  });
});

describe('snooze_attention — what it will not snooze', () => {
  it('leaves an item waiting on its ferret for information or a discussion alone, parked or not', async () => {
    for (const waitingFor of ['info', 'discussion']) {
      const { r, bodies } = world([a12({ waitingOn: 'ferret', askedAt: '2026-11-24T11:00:00.000Z', waitingFor })]);
      const reply = await tool(r, 'snooze_attention', { item: 'A12', duration: '2h' });
      should(reply.isError).be.true();
      should(reply.text).containEql('is waiting on its ferret, not on you, so there is nothing to snooze.');
      should(bodies.length).equal(0);
    }
  });
});

describe('snooze_attention — a title is a write target only when it is exact', () => {
  const two = () => {
    const theirs = agendaItem({
      id: 'A12',
      subject: 'Marin asks',
      why: 'Marin?',
      raisedBySession: MARIN.config.id,
      extra: { title: 'Today: close OCBC 365 card' },
    });
    return world([a12()], { also: [[MARIN.config.id, [theirs]]] });
  };

  it('snoozes by the whole title, in any case, and never by a part of it', async () => {
    const { r, bodies } = world([a12()]);
    const part = await tool(r, 'snooze_attention', { item: 'close OCBC', duration: '2h' });
    should(part.isError).be.true();
    should(part.text).containEql('no item has exactly that title.');
    should(part.text).containEql('Did you mean !A12 (Today: close OCBC 365 card)?');
    should(bodies.length).equal(0);
    const whole = await tool(r, 'snooze_attention', { item: 'today: CLOSE ocbc 365 card', duration: '2h' });
    should(whole.isError).be.false();
    should(bodies.length).equal(1);
  });

  it('asks which one when two ferrets have the same exact title, and `ferret` settles it', async () => {
    const { r, bodies } = two();
    const both = await tool(r, 'snooze_attention', { item: 'Today: close OCBC 365 card', duration: '2h' });
    should(both.isError).be.true();
    should(both.text).containEql('More than one item matches');
    should(bodies.length).equal(0);
    await tool(r, 'snooze_attention', { item: 'Today: close OCBC 365 card', duration: '2h', ferret: 'marin' });
    should(bodies.map(entry => entry.path)).eql([`/v1/sessions/${MARIN.config.id}/agenda`]);
  });

  it('says so when the ferret it names has no open items', async () => {
    const { r, bodies } = world([a12()]);
    const reply = await tool(r, 'snooze_attention', {
      item: 'Today: close OCBC 365 card',
      duration: '2h',
      ferret: 'marin',
    });
    should(reply.isError).be.true();
    should(reply.text).equal('Marin has no open items.');
    should(bodies.length).equal(0);
  });
});

describe('answer_attention and list_attention agree on what is open', () => {
  const due = (id: string, extra: Record<string, unknown> = {}) =>
    agendaItem({
      id,
      subject: 'Approve it',
      why: 'OK?',
      ask: { kind: 'permission' },
      raisedBySession: id === 'A12' ? LIZ.config.id : MARIN.config.id,
      extra: {
        parked: { reason: 'snoozed', at: '2026-11-24T10:00:00.000Z', until: '2026-11-24T11:00:00.000Z' },
        ...extra,
      },
    });

  it('answers a snoozed item whose time has come, before the daemon timer has woken it', async () => {
    const { r, bodies } = world([due('A12')]);
    should((await tool(r, 'list_attention', {})).text).containEql('!A12');
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'approve' });
    should(reply.isError).be.false();
    should(bodies.map(entry => entry.body.action)).eql(['resolve']);
  });

  it('does not answer one that is still asleep', async () => {
    const asleep = due('A12', {
      parked: { reason: 'snoozed', at: '2026-11-24T10:00:00.000Z', until: '2026-11-25T11:00:00.000Z' },
    });
    const { r, bodies } = world([asleep]);
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'approve' });
    should(reply.isError).be.true();
    should(reply.text).containEql('There is no open item A12.');
    should(bodies.length).equal(0);
  });

  it('asks which ferret when the due item shares its id with an open one, instead of answering the other board', async () => {
    const mine = due('A12');
    const theirs = agendaItem({
      id: 'A12',
      subject: 'Marin asks',
      why: 'OK?',
      ask: { kind: 'permission' },
      raisedBySession: MARIN.config.id,
    });
    const { r, bodies } = world([mine], { also: [[MARIN.config.id, [theirs]]] });
    const reply = await tool(r, 'answer_attention', { item: 'A12', answer: 'approve' });
    should(reply.isError).be.true();
    should(reply.text).equal('Item A12 is open for more than one ferret (Lizzette and Marin). Which ferret asked?');
    should(bodies.length).equal(0);
  });
});

describe('a ferret’s words are cleaned before they are cut', () => {
  const redact = async (text: string) => text.replace(/sk-[A-Za-z0-9]{20,}/gu, '[redacted]');
  const key = `sk-${'Q'.repeat(30)}`;
  const untitled = (id: string, subject: string) =>
    agendaItem({ id, subject, why: `Why? ${'w'.repeat(230)} ${key}`, ask: { kind: 'task' }, kind: 'task' });

  it('leaves no fragment of a credential at the cutoff of the heading, the suggestions, the list or the receipt', async () => {
    const { r } = world([untitled('A98', `${'a'.repeat(55)} ${key}`), untitled('A97', `${'b'.repeat(115)} ${key}`)], {
      redact,
    });
    const texts = [
      (await tool(r, 'get_attention', { item: 'A97' })).text.split('\n')[0],
      (await tool(r, 'get_attention', { item: 'A99' })).text,
      (await tool(r, 'list_attention', {})).text,
      (await tool(r, 'snooze_attention', { item: 'A98', duration: '2h' })).text,
      (await tool(r, 'snooze_attention', { item: 'zzzzzzzz', duration: '2h' })).text,
    ];
    for (const text of texts) {
      should(text).not.containEql('sk-');
      should(text).not.containEql('QQQQ');
    }
    should(texts[3]).containEql(' [re…)');
  });
});
