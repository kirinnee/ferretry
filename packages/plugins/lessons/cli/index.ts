import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { LessonsController } from './lib/controller.ts';
import { ClientLessonsGateway } from './lib/gateway.ts';

const flag = (invocation: VerbInvocation, name: string): boolean => invocation.options[name] === true;
const value = (invocation: VerbInvocation, name: string): string | undefined => {
  const raw = invocation.options[name];
  return typeof raw === 'string' ? raw : undefined;
};
const argument = (invocation: VerbInvocation, index: number): string => invocation.args[index] ?? '';

/**
 * `fy lesson …` (docs/lessons.md): judge the lessons the daemon suggests from your corrections, and, from inside a
 * ferret, file one. Every verb is a thin call on a lesson route; a refusal prints its sentence and exits 1.
 */
export default implementCli(manifest, {
  build({ client, io }) {
    const controller = new LessonsController(
      new ClientLessonsGateway(client),
      { success: text => io.out(`${text}\n`) },
      'fy',
    );
    const run = (work: () => Promise<void>) => async (): Promise<number> => {
      try {
        await work();
        return 0;
      } catch (error) {
        io.err(`${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    };
    const options = (invocation: VerbInvocation) => ({ json: flag(invocation, 'json') });
    const verbs = (work: (invocation: VerbInvocation) => Promise<void>) => async (invocation: VerbInvocation) =>
      await run(() => work(invocation))();
    return {
      verbs: {
        lesson: verbs(
          async invocation =>
            await controller.list({
              ...options(invocation),
              ...(value(invocation, 'state') === undefined ? {} : { state: value(invocation, 'state') as string }),
              all: flag(invocation, 'all'),
            }),
        ),
        'lesson show': verbs(async invocation => await controller.show(argument(invocation, 0), options(invocation))),
        'lesson accept': verbs(
          async invocation => await controller.accept(argument(invocation, 0), options(invocation)),
        ),
        'lesson reject': verbs(
          async invocation =>
            await controller.reject(argument(invocation, 0), {
              ...options(invocation),
              ...(value(invocation, 'note') === undefined ? {} : { note: value(invocation, 'note') as string }),
            }),
        ),
        'lesson edit': verbs(
          async invocation =>
            await controller.edit(argument(invocation, 0), invocation.args.slice(1), options(invocation)),
        ),
        'lesson categorize': verbs(
          async invocation =>
            await controller.categorize(argument(invocation, 0), argument(invocation, 1), options(invocation)),
        ),
        'lesson reopen': verbs(
          async invocation => await controller.reopen(argument(invocation, 0), options(invocation)),
        ),
        'lesson apply': verbs(
          async invocation =>
            await controller.apply(argument(invocation, 0), { ...options(invocation), yes: flag(invocation, 'yes') }),
        ),
        'lesson scan': verbs(
          async invocation =>
            await controller.scan({
              ...options(invocation),
              estimate: flag(invocation, 'estimate'),
              start: flag(invocation, 'start'),
              ...(value(invocation, 'ferrets') === undefined
                ? {}
                : { ferrets: value(invocation, 'ferrets') as string }),
              ...(value(invocation, 'agent') === undefined ? {} : { agent: value(invocation, 'agent') as string }),
              ...(value(invocation, 'model') === undefined ? {} : { model: value(invocation, 'model') as string }),
            }),
        ),
        'lesson patch': verbs(async invocation => await controller.patch(argument(invocation, 0), options(invocation))),
        'lesson run': verbs(
          async invocation => await controller.run({ ...options(invocation), spawn: flag(invocation, 'spawn') }),
        ),
        'lesson status': verbs(async invocation => await controller.status(options(invocation))),
        'lesson config': verbs(async invocation => await controller.config(options(invocation))),
        'lesson suggest': verbs(
          async invocation =>
            await controller.suggest(argument(invocation, 0), value(invocation, 'scope') ?? '', options(invocation)),
        ),
      },
    };
  },
});
