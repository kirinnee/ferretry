import { ferretOf } from '@ferretry/core-gate/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import type { CallContext } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import {
  AgentLessonToolCallSchema,
  type LessonsConfig,
  LESSONS_CONFIG,
  LessonsChanged,
  lessonsConfigFromFile,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { ConversationPassiveChannel } from './adapters/passive-channel.ts';
import { LESSONS_MINER_NAME, FerretLessonSessions } from './adapters/ferret-sessions.ts';
import { StateGlobalLessons, WorkRootLessonFiles } from './adapters/instruction-files.ts';
import { LessonsMiner } from './adapters/miner.ts';
import { UnpricedModels } from './adapters/no-prices.ts';
import { StateLessonsStore } from './adapters/state-store.ts';
import { lessonsParts } from './launch-parts.ts';
import { LessonsService, SerialSection } from './lib/index.ts';
import { lessonsRoutes } from './routes.ts';

/**
 * The name of the command a human drives, which a lesson tells a ferret to run. The binary name is a fact of
 * `packages/cli/package.json`; no kernel port carries it, so this is the one place the daemon half says it.
 */
const BINARY_NAME = 'fy';

/**
 * Lessons (§2.3): the board of suggestions, the owner's verdicts, Apply (a diff preview and an etag write), the passive
 * switch and the explicit scan.
 *
 * DECLARED GAPS (each says what is missing, in words, rather than guess):
 *  - `ConfigPort` has no write, so `PATCH /v1/lessons/config` keeps the owner's machine switch in `state.json`, where it
 *    overrides `lessons.yaml`.
 *  - A scan's price comes from Usage's price list, which Lessons may not import: an estimate carries no `usd`.
 *  - A miner is started by `FerretsApi.start`, which takes no model; the scan's model is not passed on.
 *  - A miner ferret runs in the folder of the first ferret it reads and writes its answer there as a dotfile the ingest
 *    removes; there is no folder of Lessons' own a ferret may work in.
 *  - A transcript carries no tool results or interrupts, so a digest counts neither.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const { conversation, ferrets } = ctx.needs;
    const store = new StateLessonsStore(kernel);
    const serial = new SerialSection();
    const now = () => kernel.clock.now();

    // ── the machine switch: lessons.yaml, with the owner's switch laid over it ────────────────────────────────────────
    let machineDefault: boolean | undefined;
    let loaded: Promise<void> | undefined;
    const load = (): Promise<void> => {
      loaded ??= store.passiveDefault().then(value => {
        machineDefault = value;
      });
      return loaded;
    };
    const config = (): LessonsConfig => {
      const file = lessonsConfigFromFile(kernel.config.file(LESSONS_CONFIG));
      return machineDefault === undefined ? file : { ...file, passiveDefault: machineDefault };
    };

    const miner = new LessonsMiner({ store, ferrets, conversation, roots: kernel.roots, config, now });
    const lessons = new LessonsService({
      store,
      sessions: new FerretLessonSessions(ferrets, conversation),
      files: new WorkRootLessonFiles(ferrets, kernel.roots, store),
      global: new StateGlobalLessons(),
      passive: new ConversationPassiveChannel(conversation),
      miner,
      prices: new UnpricedModels(),
      config,
      now,
      binaryName: BINARY_NAME,
      minerLabel: 'ferretry-lessons',
    });

    let generation = 0;
    const changed = (): void => {
      generation += 1;
      kernel.events.publish(LessonsChanged, { generation });
    };
    const subsystem = {
      store,
      serial,
      config: async () => {
        await load();
        return config();
      },
      now,
      run: async (spawn: boolean) => {
        await load();
        return await miner.run(spawn);
      },
      lessons,
      writeConfig: async (patch: { readonly passiveDefault: boolean }) => {
        await load();
        await store.setPassiveDefault(patch.passiveDefault);
        machineDefault = patch.passiveDefault;
        changed();
        return config();
      },
      changed,
    };

    // Every route reads a loaded machine switch first.
    const loadedRoutes = Object.fromEntries(
      Object.entries(lessonsRoutes(subsystem)).map(([key, handler]) => [
        key,
        async (call: CallContext) => {
          await load();
          return await handler(call);
        },
      ]),
    ) as ReturnType<typeof lessonsRoutes>;

    const adopt = async (ferret: string, name: string): Promise<boolean> => {
      await load();
      // A miner is never instructed to learn.
      if (name === LESSONS_MINER_NAME) return false;
      const existing = (await store.loadFerretLessons()).find(entry => entry.ferretId === ferret);
      if (existing !== undefined) return existing.passive;
      return (await serial.run(async () => (await lessons.adopt(ferret)).passive)) ?? false;
    };

    const SuggestInput = z.strictObject({
      rule: AgentLessonToolCallSchema.options[0].shape.rule,
      scope: AgentLessonToolCallSchema.options[0].shape.scope,
    });

    return {
      routes: loadedRoutes,
      tools: {
        lessons_suggest: async (call, input) => {
          const ferret = ferretOf(call);
          if (ferret === undefined)
            return {
              text: 'Filing a lesson needs the credential Ferretry gives each ferret; run it from inside a ferret.',
              isError: true,
            };
          const parsed = SuggestInput.safeParse(input);
          if (!parsed.success)
            return {
              text: `The lesson is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}`,
              isError: true,
            };
          const result = await serial.run(
            async () => await lessons.suggest(ferret, parsed.data.rule, parsed.data.scope),
          );
          changed();
          return { text: result.summary };
        },
      },
      provides: {
        lessons: {
          passive: async ferret => await adopt(ferret, (await ferrets.get(ferret))?.name ?? ''),
          suggest: async (ferret, rule, scope) =>
            await serial.run(async () => await lessons.suggest(ferret, rule, scope)),
        },
      },
      hooks: {
        'launch.parts': () => [
          { id: 'lessons', item: lessonsParts({ passive: adopt, global: () => store.readGlobal() }, BINARY_NAME) },
        ],
        // A miner's turn ended: fold in whatever it has written, so a scan's progress moves without anyone looking.
        'turn.ended': payload => {
          void (async () => {
            const ferret = await ferrets.get(payload.ferret as FerretId);
            if (ferret?.name !== LESSONS_MINER_NAME) return;
            await load();
            await serial.run(async () => await lessons.scanProgress());
            changed();
          })().catch(error => kernel.log.warn('a miner turn could not be folded in', { error: String(error) }));
        },
      },
    };
  },
});
