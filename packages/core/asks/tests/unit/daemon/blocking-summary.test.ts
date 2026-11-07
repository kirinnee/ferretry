import { expect, it } from 'bun:test';
import { asksHalf } from '../../support/daemon/asks-half.ts';
import { AskSummarySchema, type AskDraft } from '../../../contract/index.ts';

it('preserves the blocking flag on notice summaries for notify buzz decisions', async () => {
  const half = await asksHalf();
  const draft: Omit<AskDraft, 'kind' | 'options'> = {
    source: 'daemon',
    entry: 'buzz1',
    ref: {},
    subject: 'Check the release',
    why: 'Ready to read.',
    raisedBy: { kind: 'daemon' },
    ferret: 'f1',
    blocking: true,
  };
  try {
    const ref = await half.asks.notify(draft);
    const summary = await half.asks.get(ref);
    expect(summary).toMatchObject({ blocking: true });
    expect(AskSummarySchema.parse(summary)).toMatchObject({ blocking: true });
    expect(await half.asks.open({ source: 'daemon' as never })).toMatchObject([{ blocking: true }]);
    await half.asks.close(ref, 'dismissed');
    expect(await half.asks.get(ref)).toMatchObject({ blocking: true });
  } finally {
    await half.close();
  }
});
