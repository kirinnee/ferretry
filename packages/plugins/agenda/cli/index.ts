import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import {
  AgendaClearAgentsResultSchema,
  AgendaModeSchema,
  AgendaOpenPageSchema,
  AGENDA_OPEN_MAX_LIMIT,
  type AgendaOpenPage,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { composeNoticeRequest } from './lib/notify.ts';
import { describeClear, renderOpen } from './lib/render.ts';

const text = (value: string | boolean | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
const flag = (invocation: VerbInvocation, name: string): boolean => invocation.options[name] === true;

/**
 * Agenda's `fy` half (§2.3): `fy agenda` and `fy agenda open` (what waits on you), `fy agenda mode` (today's `fy notify
 * agenda`), `fy agenda clear` and `fy notify`. Every call goes through the plugin client with the manifest's route keys;
 * a verb that raises a notice calls Asks' board route, which Agenda's manifest consumes through its `needs`.
 *
 * The item verbs (`add`, `answer`, `edit`, `snooze`, …) are `fy ask`, the shell's. A ferret's own id (`FY_SESSION_ID`) is
 * not in the CLI context yet (DECISIONS-1 #21), so `--ferret <id>` names it; and no prompt exists yet, so a clear that is
 * not a dry run asks for `--yes`.
 */
export default implementCli(manifest, {
  build({ client, io }) {
    const fail = (message: string): number => {
      io.err(`${message}\n`);
      return 1;
    };
    const say = (message: string): void => io.out(`${message}\n`);

    async function open(invocation: VerbInvocation, all: boolean): Promise<number> {
      const limit = text(invocation.options.limit);
      if (limit !== undefined && !/^[1-9][0-9]*$/u.test(limit))
        return fail('--limit is a whole number of asks, 1 or more');
      if (limit !== undefined && Number(limit) > AGENDA_OPEN_MAX_LIMIT)
        return fail(`--limit is at most ${String(AGENDA_OPEN_MAX_LIMIT)}`);
      let after = text(invocation.options.after);
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
      if (flag(invocation, 'json')) say(JSON.stringify({ sessions, ...(next === undefined ? {} : { next }) }, null, 2));
      else say(renderOpen({ sessions, ...(next === undefined ? {} : { next }) }));
      return 0;
    }

    return {
      verbs: {
        agenda: async invocation => await open(invocation, true),
        'agenda open': async invocation => await open(invocation, false),

        'agenda mode': async invocation => {
          const ferret = text(invocation.options.ferret);
          if (ferret === undefined) return fail('say which ferret: --ferret <id>');
          const state = invocation.args[0]?.trim().toLowerCase();
          if (state !== undefined && state !== 'on' && state !== 'off')
            return fail(`agenda mode is "on" or "off", not "${invocation.args[0] ?? ''}" — leave it out to read it`);
          const params = { ferretId: ferret };
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
          if (!flag(invocation, 'agents'))
            return fail(
              'say what to clear: `agenda clear --agents` clears every open ask on the agent ferrets’ boards',
            );
          const found = AgendaClearAgentsResultSchema.parse(
            await client.call('POST /v1/agenda/clear-agents', { body: { dryRun: true } }),
          );
          if (flag(invocation, 'dry-run')) {
            say(`would clear ${describeClear(found)}`);
            return 0;
          }
          if (found.cleared === 0) {
            say('nothing to clear: the agent ferrets have no open asks');
            return 0;
          }
          if (!flag(invocation, 'yes'))
            return fail(
              `this would dismiss ${describeClear(found)} and nobody can be asked here: re-run with --yes to go ahead`,
            );
          const done = AgendaClearAgentsResultSchema.parse(
            await client.call('POST /v1/agenda/clear-agents', { body: {} }),
          );
          say(flag(invocation, 'json') ? JSON.stringify(done, null, 2) : `cleared ${describeClear(done)}`);
          return 0;
        },

        notify: async invocation => {
          const ferret = text(invocation.options.ferret);
          if (ferret === undefined) return fail('no ferret id — pass --ferret <id>');
          let request: ReturnType<typeof composeNoticeRequest>;
          try {
            request = composeNoticeRequest(invocation.args, {
              body: text(invocation.options.body),
              buzz: flag(invocation, 'buzz'),
            });
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
          await client.call('POST /v1/ferrets/:ferretId/agenda', { params: { ferretId: ferret }, body: request });
          say(
            `Sent. The owner sees it in this ferret's agenda${flag(invocation, 'buzz') ? ' and their phone buzzes' : ''}.`,
          );
          return 0;
        },
      },
    };
  },
});
