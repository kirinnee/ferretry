import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import type { ScratchPlanView, ScratchSweepView, TidyPlan } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { renderApplied, renderDryRun, renderScratchPlan, renderScratchSweep, type TidyOutcome } from './lib/render.ts';

const OK = 0;
const FAILED = 1;
const USAGE = 2;

const BINARY = 'fy';
const DEFAULT_REASON = 'tidy: the board is opt-in and this only tracked work';

const wantsJson = (invocation: VerbInvocation): boolean => invocation.options.json === true;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The text of a value option, or `undefined` when it is absent or given as a bare switch. */
function textOf(invocation: VerbInvocation, name: string): string | undefined {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[value.length - 1] as string | undefined;
  return undefined;
}

/**
 * Tidy (cli half, §2.3): `fy gc` and `fy tidy`. `fy gc` asks the daemon for the scratch plan or sweep. `fy tidy` asks for
 * the calling ferret's plan (the daemon names the ferret from the credential; `--session` is gone with the header that
 * carried it) and, with `--yes`, applies it with the card drop and the ask close the ferret could have typed itself, one
 * by one, saying each failure without stopping. Write positionals before options.
 */
export default implementCli(manifest, {
  build: ({ client, io }) => ({
    verbs: {
      gc: async invocation => {
        const limitText = textOf(invocation, 'limit');
        if (invocation.options['dry-run'] !== true) {
          if (invocation.options.limit !== undefined) {
            io.err('--limit applies only to `gc --dry-run`');
            return USAGE;
          }
          const result = await client.call<ScratchSweepView>('POST /v1/gc', { body: { force: false } });
          io.out(wantsJson(invocation) ? JSON.stringify(result, null, 2) : renderScratchSweep(result));
          return OK;
        }
        const limit = limitText === undefined ? 20 : Number(limitText);
        if (!Number.isInteger(limit) || limit <= 0) {
          io.err('--limit must be a positive integer');
          return USAGE;
        }
        const plan = await client.call<readonly ScratchPlanView[]>('GET /v1/gc', { query: { limit: String(limit) } });
        io.out(wantsJson(invocation) ? JSON.stringify(plan, null, 2) : renderScratchPlan(plan));
        return OK;
      },

      tidy: async invocation => {
        if (invocation.options.session !== undefined) {
          io.err(`${BINARY} tidy tidies the ferret whose credential it carries; run it inside that ferret's own pane`);
          return USAGE;
        }
        const reason = textOf(invocation, 'reason')?.trim();
        if (invocation.options.reason !== undefined && (reason === undefined || reason === '')) {
          io.err('--reason needs words: why these are being tidied');
          return USAGE;
        }
        const plan = await client.call<TidyPlan>('POST /v1/tidy/plan');
        if (invocation.options.yes !== true) {
          io.out(
            wantsJson(invocation) ? JSON.stringify({ applied: false, plan }, null, 2) : renderDryRun(plan, BINARY),
          );
          return OK;
        }
        const why = reason ?? DEFAULT_REASON;
        const dropped: TidyOutcome[] = [];
        for (const each of plan.drop) {
          const outcome = { reference: `&${each.id}`, title: each.title };
          try {
            await client.call('POST /v1/board/cards/:cardId', {
              params: { cardId: each.id },
              body: { action: 'drop', reason: why },
            });
            dropped.push(outcome);
          } catch (error) {
            dropped.push({ ...outcome, error: messageOf(error) });
          }
        }
        const closed: TidyOutcome[] = [];
        for (const each of plan.close) {
          const outcome = { reference: `!${each.id}`, title: each.subject };
          try {
            await client.call('POST /v1/ferrets/:ferretId/agenda', {
              params: { ferretId: plan.ferret },
              body: { action: 'resolve', id: each.id, note: why },
            });
            closed.push(outcome);
          } catch (error) {
            closed.push({ ...outcome, error: messageOf(error) });
          }
        }
        const result = { dropped, closed };
        io.out(
          wantsJson(invocation)
            ? JSON.stringify({ applied: true, plan, result }, null, 2)
            : renderApplied(plan, result),
        );
        const failed = [...dropped, ...closed].filter(outcome => outcome.error !== undefined).length;
        if (failed > 0) {
          io.err(`${String(failed)} change(s) failed; the rest were applied (see above)`);
          return FAILED;
        }
        return OK;
      },
    },
  }),
});
