import { ferretOf } from '@ferretry/core-gate/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import {
  AgentLessonToolCallSchema,
  type LessonsConfig,
  type LessonsConfigPatch,
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
 *  - A scan's price comes from Usage's price list, which Lessons may not import: an estimate carries no `usd`.
 *  - There is no work folder of Lessons' own a ferret may be started in (D2 #19's additive Ferrets start work folder and
 *    kernel WorkFolders are not on this base), so starting a miner — a scan, or `POST /v1/lessons/run {spawn: true}` —
 *    REFUSES. Today's miner runs in the daemon's home and writes under `state/learning/runs/`; it never runs in or
 *    writes to an owner's project, so falling back to one is not an option. An estimate, an ingest-only run and the
 *    board keep working.
 *  - A transcript carries no tool results or interrupts, so a digest counts neither.
 *  - An owner's own save of `lessons.yaml` is refused (409 `config_held`) while another edit is held, instead of today's
 *    both-versions write (docs/config-files.md rule 3), until the kernel ConfigPort offers an owner-acknowledged
 *    write.
 *  - A miner's `runtime` is not resolved: Ferrets' start on 5.0 does not resolve `runtime` to its harness or login, nor
 *    refuse an unknown one (today: `unknown_agent`), so a miner would launch on the first registered harness. Inert
 *    while no miner can start (the work-folder gap above); it must close before that one does.
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const { conversation, ferrets } = ctx.needs;
    const store = new StateLessonsStore(kernel);
    const serial = new SerialSection();
    const now = () => kernel.clock.now();

    // ── the machine switch: lessons.yaml alone, the one source of truth (docs/config-files.md) ────────────────────────
    const config = (): LessonsConfig => lessonsConfigFromFile(kernel.config.file(LESSONS_CONFIG));

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
      config: async () => config(),
      writeConfig: async (patch: LessonsConfigPatch) => await kernel.config.write(LESSONS_CONFIG, undefined, { patch }),
      configHeld: () => kernel.config.fileState(LESSONS_CONFIG).state === 'held',
      now,
      run: async (spawn: boolean) => await miner.run(spawn),
      lessons,
      changed,
    };

    const adopt = async (ferret: string, name: string): Promise<boolean> => {
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
      routes: lessonsRoutes(subsystem),
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
            await serial.run(async () => await lessons.scanProgress());
            changed();
          })().catch(error => kernel.log.warn('a miner turn could not be folded in', { error: String(error) }));
        },
      },
    };
  },
});
