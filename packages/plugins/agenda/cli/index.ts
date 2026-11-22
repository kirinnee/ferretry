import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import {
  AgendaClearAgentsResultSchema,
  AgendaModeSchema,
  AgendaOpenPageSchema,
  AGENDA_OPEN_MAX_LIMIT,
  type AgendaOpenPage,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { describeClear, renderOpen } from './lib/render.ts';
import { readVerb } from './lib/verb-flags.ts';

const text = (value: string | boolean | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * Agenda's `fy` half (§2.3): `fy agenda` and `fy agenda open` (what waits on you), `fy agenda mode` (today's `fy notify
 * agenda`) and `fy agenda clear`. Every call goes through the plugin client with the manifest's route keys. The item verbs
 * (`add`, `edit`, `done`, …) and `fy notify` are Asks' (core): they work with this plugin off. A clear that is not a dry run
 * asks for `--yes`.
 */
export default implementCli(manifest, {
  build({ client, io, confirm }) {
    const fail = (message: string): number => {
      io.err(`${message}\n`);
      return 1;
    };
    const say = (message: string): void => io.out(`${message}\n`);

    async function open(verb: 'open' | 'roll', invocation: VerbInvocation, all: boolean): Promise<number> {
      const read = readVerb(verb, invocation);
      if (!read.ok) return fail(read.message);
      const given = read.flags as { readonly limit?: string; readonly after?: string; readonly json?: boolean };
      const limit = text(given.limit);
      if (limit !== undefined && !/^[1-9][0-9]*$/u.test(limit))
        return fail('--limit is a whole number of asks, 1 or more');
      if (limit !== undefined && Number(limit) > AGENDA_OPEN_MAX_LIMIT)
        return fail(`--limit is at most ${String(AGENDA_OPEN_MAX_LIMIT)}`);
      let after = text(given.after);
      const sessions: AgendaOpenPage['sessions'][number][] = [];
      let next: string | undefined;
      do {
        const page = AgendaOpenPageSchema.parse(
          await client.call('GET /v1/agenda/open', {
            query: { ...(after === undefined ? {} : { after }), ...(limit === undefined ? {} : { limit }) },
          }),
        );
        sessions.push(...page.sessions);
        next = page.next;
        after = page.next;
      } while (all && next !== undefined);
      if (given.json === true) say(JSON.stringify({ sessions, ...(next === undefined ? {} : { next }) }, null, 2));
      else say(renderOpen({ sessions, ...(next === undefined ? {} : { next }) }));
      return 0;
    }

    const prompt =
      io.isTty && confirm !== undefined
        ? { ask: async (question: string) => ((await confirm(question)) ? 'y' : 'n') }
        : undefined;
    /** What a refused flag or word costs: the sentence, and exit 1 as v4's parser did (an unknown SUB-VERB is the shell's exit 2). */
    const refused = fail;

    return {
      verbs: {
        agenda: async invocation => await open('roll', invocation, true),
        'agenda open': async invocation => await open('open', invocation, false),

        'agenda mode': async invocation => {
          const read = readVerb('mode', invocation);
          if (!read.ok) return refused(read.message);
          if (read.ferret === undefined || read.ferret.trim() === '') return fail('say which ferret: --ferret <id>');
          const state = read.args[0]?.trim().toLowerCase();
          if (state !== undefined && state !== 'on' && state !== 'off')
            return fail(`agenda mode is "on" or "off", not "${read.args[0] ?? ''}" — leave it out to read it`);
          const params = { ferretId: read.ferret.trim() };
          if (state === undefined) {
            const mode = AgendaModeSchema.parse(await client.call('GET /v1/ferrets/:ferretId/agenda-mode', { params }));
            say(`Agenda mode is ${mode.enabled ? 'on' : 'off'}. ${mode.note}`);
            return 0;
          }
          const switched = (await client.call<{ enabled: boolean; note: string }>(
            'PATCH /v1/ferrets/:ferretId/agenda-mode',
            {
              params,
              body: { enabled: state === 'on' },
            },
          )) as { enabled: boolean; note: string };
          say(`Agenda mode is now ${switched.enabled ? 'on' : 'off'}. ${switched.note}`);
          return 0;
        },

        'agenda clear': async invocation => {
          const read = readVerb('clear', invocation);
          if (!read.ok) return refused(read.message);
          const given = read.flags as {
            readonly agents?: boolean;
            readonly yes?: boolean;
            readonly dryRun?: boolean;
            readonly json?: boolean;
          };
          if (given.agents !== true)
            return fail(
              'say what to clear: `agenda clear --agents` clears every open ask on the agent ferrets’ boards',
            );
          const found = AgendaClearAgentsResultSchema.parse(
            await client.call('POST /v1/agenda/clear-agents', { body: { dryRun: true } }),
          );
          if (given.dryRun === true) {
            say(`would clear ${describeClear(found)}`);
            return 0;
          }
          if (found.cleared === 0) {
            say('nothing to clear: the agent ferrets have no open asks');
            return 0;
          }
          if (given.yes !== true) {
            if (prompt === undefined)
              return fail(
                `this would dismiss ${describeClear(found)} and nobody can be asked here: re-run with --yes to go ahead`,
              );
            const answer = (await prompt.ask(`Dismiss ${describeClear(found)}? [y/N]`)).trim().toLowerCase();
            if (answer !== 'y' && answer !== 'yes') {
              say('Nothing was cleared.');
              return 0;
            }
          }
          const done = AgendaClearAgentsResultSchema.parse(
            await client.call('POST /v1/agenda/clear-agents', { body: {} }),
          );
          if (given.json === true) say(JSON.stringify(done, null, 2));
          else say(`cleared ${describeClear(done)}`);
          // The dry run said what would go; a clear that dismissed fewer left asks open, and says so rather than succeeding.
          if (done.cleared < found.cleared)
            return fail(
              `only ${describeClear(done)} were cleared, of the ${describeClear(found)} it listed: the rest are still open (see \`fy agenda ls --session <id>\`)`,
            );
          return 0;
        },
      },
    };
  },
});
