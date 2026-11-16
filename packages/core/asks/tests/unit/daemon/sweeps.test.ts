import { expect, it } from 'bun:test';
import { asksHalf } from '../../support/daemon/asks-half.ts';
import type { AskDraft } from '../../../contract/index.ts';
import { ferretStanding } from '@ferretry/core-gate/contract/testing';
import { milliseconds } from '@ferretry/std';

const POST = 'POST /v1/ferrets/:ferretId/agenda';
const GET = 'GET /v1/ferrets/:ferretId/agenda';
const params = { ferretId: 'f1' };
const draft: AskDraft = {
  source: 'daemon',
  entry: 'sleep1',
  ref: {},
  kind: 'yesno',
  subject: 'Wake me?',
  why: 'Needs an answer.',
  raisedBy: { kind: 'daemon' },
  ferret: 'f1',
};
const listed = async (half: Awaited<ReturnType<typeof asksHalf>>) =>
  (await half.call(GET, params)).json<{
    items: { parked?: unknown; waitingOn?: string; history?: { note?: string }[] }[];
  }>();

it('J-0047 J-0254 wakes overdue snoozes in a periodic kernel job and at startup', async () => {
  const half = await asksHalf();
  try {
    const ref = await half.asks.raise(draft);
    await half.call(POST, params, {
      action: 'snooze',
      id: ref.id,
      until: new Date(half.clock.nowMs() + 60_000).toISOString(),
    });
    await half.clock.advance(120_000);
    const job = half.jobs.find(job => job.id === 'wake');
    expect(job?.schedule).toEqual({ every: milliseconds(60_000) });
    if (job === undefined) throw new Error('missing wake job');
    await job.run(new AbortController().signal);
    expect((await listed(half)).items[0]?.parked).toBeUndefined();
    await half.call(POST, params, {
      action: 'snooze',
      id: ref.id,
      until: new Date(half.clock.nowMs() + 60_000).toISOString(),
    });
    const restarted = await half.restart();
    await restarted.clock.advance(3_600_000);
    await restarted.start();
    expect((await listed(restarted)).items[0]?.parked).toBeUndefined();
    await restarted.close();
  } finally {
    await half.close();
  }
});

it('J-0046 J-0253 resurfaces overdue discussions at startup only when configured', async () => {
  for (const configured of [false, true]) {
    const half = await asksHalf({}, configured ? { resurfaceAfterMinutes: 30 } : {});
    try {
      await half.call(
        POST,
        params,
        {
          action: 'add',
          title: 'Choose release',
          subject: 'Which branch?',
          why: 'Release waits.',
          premise: 'Two candidates.',
          context: 'The branch needs choosing.',
          howToResolve: 'Name one.',
          ask: { kind: 'open-question' },
        },
        ferretStanding('f1' as never),
      );
      expect((await half.call(POST, params, { action: 'discuss', id: 'A1' })).status).toBe(200);
      const restarted = await half.restart();
      await restarted.clock.advance(31 * 60_000);
      await restarted.start();
      const item = (await listed(restarted)).items[0];
      expect(item?.waitingOn).toBe(configured ? undefined : 'ferret');
      if (configured) expect(item?.history?.at(-1)?.note).toBe('No reply in 30 minutes: surfaced by the timer.');
      await restarted.close();
    } finally {
      await half.close();
    }
  }
});
