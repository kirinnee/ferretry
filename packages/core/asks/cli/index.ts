import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { AsksController } from './lib/controller.ts';
import { itemVerbs } from './lib/item-verbs.ts';
import { composeNoticeRequest } from './lib/notify.ts';

const text = (value: string | boolean | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * Asks' CLI half: every `fy agenda` item verb (`add`, `edit`, `answer`, `rest`, `log`, `merge`, `split`, `step`, `show`, `patch`, `ls`,
 * `history`, `needs-info`, `discuss`, `surface`, `snooze`, `unsnooze`, `send-now`, `done`, `dismiss`) and `fy notify`, v4's words.
 * They speak Asks' own board routes, so a ferret can raise, follow and answer its owner with the Agenda plugin off; the
 * Agenda plugin adds only its own views (`fy agenda`, `open`, `mode`, `clear`). `fy ask` is the shell's own list-and-answer.
 */
export default implementCli(manifest, {
  build(ctx) {
    const { client, io } = ctx;
    const { item } = itemVerbs(ctx, (...deps) => new AsksController(...deps));
    return {
      verbs: {
        'agenda add [ask...]': item('add', async (c, args, f) => void (await c.add(args, f))),
        'agenda edit <id>': item('edit', async (c, [id], f) => void (await c.edit(id as string, f))),
        'agenda answer <id> <text...>': item(
          'answer',
          async (c, [id, ...words], f) => void (await c.answer(id as string, words, f)),
        ),
        'agenda rest <id>': item('rest', async (c, [id], f) => void (await c.rest(id as string, f))),
        'agenda log <id>': item('log', async (c, [id], f) => void (await c.log(id as string, f))),
        'agenda merge <into> <from>': item(
          'merge',
          async (c, [into, from], f) => void (await c.merge(into as string, from as string, f)),
        ),
        'agenda split <id> <ask...>': item(
          'split',
          async (c, [id, ...words], f) => void (await c.split(id as string, words, f)),
        ),
        'agenda step <id> <n>': item(
          'step',
          async (c, [id, n], f) => void (await c.step(id as string, n as string, f)),
        ),
        'agenda show <id>': item('show', async (c, [id], f) => void (await c.show(id as string, f))),
        'agenda patch <id>': item('patch', async (c, [id], f) => void (await c.patch(id as string, f))),
        'agenda ls': item('ls', async (c, _args, f) => void (await c.list(f))),
        'agenda history': item('history', async (c, _args, f) => void (await c.history(f))),
        'agenda needs-info <id>': item('needs-info', async (c, [id], f) => void (await c.needsInfo(id as string, f))),
        'agenda discuss <id>': item('discuss', async (c, [id], f) => void (await c.discuss(id as string, f))),
        'agenda surface <id>': item('surface', async (c, [id], f) => void (await c.surface(id as string, f))),
        'agenda snooze <id>': item('snooze', async (c, [id], f) => void (await c.snooze(id as string, f))),
        'agenda unsnooze <id>': item('unsnooze', async (c, [id], f) => void (await c.unsnooze(id as string, f))),
        'agenda send-now': item('send-now', async (c, _args, f) => void (await c.sendNow(f))),
        'agenda done <id>': item('done', async (c, [id], f) => void (await c.resolve(id as string, f))),
        'agenda dismiss <id>': item('dismiss', async (c, [id], f) => void (await c.dismiss(id as string, f))),
        notify: async invocation => {
          const fail = (message: string): number => {
            io.err(`${message}\n`);
            return 1;
          };
          // `-s, --session` is the declared flag; `--ferret` is its former spelling. Neither: the ferret this fy runs inside.
          const ferret =
            text(invocation.options.session) ??
            text(invocation.options.s) ??
            text(invocation.options.ferret) ??
            text(ctx.env?.FY_SESSION_ID);
          if (ferret === undefined) return fail('no ferret id — run inside a ferret or pass --session <id>');
          // `--ping` is v4's spelling of `--buzz`. Help names only `--buzz` (help.test.ts), but agents' old instructions still say `--ping`.
          // It is no declared switch, so `--ping "summary"` reads the summary as its value: that word is given back.
          const ping = invocation.options.ping;
          const buzzes = invocation.options.buzz === true || (ping !== undefined && ping !== false);
          const words = typeof ping === 'string' ? [ping, ...invocation.args] : invocation.args;
          let request: ReturnType<typeof composeNoticeRequest>;
          try {
            request = composeNoticeRequest(words, {
              body: text(invocation.options.body),
              buzz: buzzes,
            });
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
          await client.call('POST /v1/ferrets/:ferretId/agenda', { params: { ferretId: ferret }, body: request });
          io.out(`Sent. The owner sees it in this ferret's agenda${buzzes ? ' and their phone buzzes' : ''}.\n`);
          return 0;
        },
      },
    };
  },
});
