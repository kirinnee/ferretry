import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import should from 'should';
import { type InputRaise, type InputTargetFacts, InputTargetFactsSchema } from '../../../../contract/index.ts';
import type { ObserveResult } from '../../../../daemon/lib/inputs/ports.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { SESSION } from './grant-fixtures.ts';
import { OWNER, refusal, world } from './world.ts';

/**
 * THE SEAM BETWEEN A BROWSER'S RE-FIND AND THE VAULT'S DECISION, over the facts a real Chrome produced
 * (`real-chrome-facts.json`, captured through Browsers' own worker by its real-Chrome re-find test, which fails when
 * the real facts stop having this shape). The Vault cannot import Browsers (a core never imports a plugin), so the page
 * is a fixture adapter that answers with those facts: the field facts are real (label, form action, DevTools frame and
 * loader, box), not hand-built. The whole service runs: the card is raised on the facts the browser read, the page
 * is re-rendered, the agent's pointer is stale, the browser re-finds, the Vault decides — type once, or redraw and type nothing.
 */

/** One run of the real browser: the card's facts, and what its re-find answered after the page changed. */
interface Run {
  readonly shown: unknown;
  readonly found: unknown;
  readonly ambiguous?: true;
}
interface Captured {
  readonly replaced: Run;
  readonly ambiguous: Run;
  readonly relabelled: Run;
  readonly repointed: Run;
}
const REAL = JSON.parse(readFileSync(new URL('./real-chrome-facts.json', import.meta.url), 'utf8')) as Captured;
const facts = (value: unknown): InputTargetFacts => InputTargetFactsSchema.parse(value);

const RAISE: InputRaise = {
  target: { kind: 'page', key: 'app' },
  prompt: 'GitHub asks for a verification code',
  fields: [{ id: 'code', label: 'Code', sensitivity: 'plain', element: { kind: 'selector', selector: '#code' } }],
  submit: 'owner-default',
};
const VALUE = '482913';

/** The card is raised on what the real browser saw first; then the page is re-rendered and only the re-find sees it. */
async function reRendered(run: Run) {
  let stale = false;
  const ambiguous = run.ambiguous === true;
  const seen = facts(run.shown);
  const again = facts(run.found);
  const w = world({
    observe: (): ObserveResult =>
      stale ? { ok: false, reason: 'target_gone' } : { ok: true, facts: seen, names: ['page-1'] },
    refind: (): ObserveResult => ({
      ok: true,
      facts: again,
      names: ['page-1'],
      ...(ambiguous ? { ambiguous: true } : {}),
    }),
  });
  await w.service.raise(SESSION, RAISE);
  const request = await w.pending();
  stale = true;
  const send = async () =>
    await w.service.deliver(SESSION, request.id, { ...w.send(request), padded: padInputValue(VALUE) }, OWNER);
  return { w, send };
}

/** A redraw: the card comes back for the owner, nothing is typed and nothing is counted as a failed check. */
async function redrawn(scenario: Awaited<ReturnType<typeof reRendered>>): Promise<void> {
  const error = await refusal(scenario.send());
  should((error as { reason?: string }).reason).equal('target_rebound');
  should(scenario.w.writes.length).equal(0);
  should(scenario.w.audits.map(entry => entry.event)).containEql('input.rebound');
  should(scenario.w.audits.map(entry => entry.event)).not.containEql('input.refused');
}

describe('a field a real browser re-found, decided by the Vault', () => {
  it('should type once into the replacement the browser proved the same field', async () => {
    const { w, send } = await reRendered(REAL.replaced);

    await send();

    should(w.writes.map(write => write.values)).eql([[VALUE]]);
  });

  it('should redraw, typing nothing, when the replacement sits in a form that now sends elsewhere', async () => {
    await redrawn(await reRendered(REAL.repointed));
  });

  it('should redraw, as a secret, when the replacement is now labelled as a card number', async () => {
    const scenario = await reRendered(REAL.relabelled);

    await redrawn(scenario);

    should((await scenario.w.pending()).fields[0]?.sensitivity).equal('secret');
  });

  it('should redraw, never type, when two elements looked like the field', async () => {
    await redrawn(await reRendered(REAL.ambiguous));
  });
});
