import { ferretOf } from '@ferretry/core-gate/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import {
  CreateConfigFile,
  CreateConfigSchema,
  CreateSpendRefSchema,
  type ResolvedCreateConfig,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import { generateAudioTools } from './lib/generate-audio.ts';
import { generateImageTool } from './lib/generate-image.ts';
import { type DeliverMedia, serialQueue, type ToolAnswer } from './lib/paid-call.ts';
import { SpendLedger } from './lib/spend.ts';

const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Create (daemon half): the agent tools that make media for a ferret that cannot, spending the owner's own keys
 * through the kernel (it places `FAL_KEY` and `ELEVENLABS_API_KEY`; this plugin never holds them) under ONE daily cap
 * and an ask over a limit, and one queue, so no two calls can pass the cap together.
 *
 * THE FILE reaches the chat with no step by the ferret: Ferrets' `deliverMedia` seam writes it into the ferret's own
 * `media/` folder (`FY_MEDIA_DIR`), and the answer is one block to paste (`src: media:<name>`) under a cost line.
 */
export default implementDaemon(manifest, {
  build({ kernel, needs }) {
    // A day is counted in the file's `timeZone`, else the host's own: the rule Usage's days follow.
    const config = (): ResolvedCreateConfig => {
      const file = kernel.config.file(CreateConfigFile) ?? CreateConfigSchema.parse({});
      return { ...file, timeZone: file.timeZone ?? hostTimeZone() };
    };
    const deliver: DeliverMedia = async (ferret, name, bytes) => {
      const harness = await needs.ferrets.harness?.(ferret as FerretId, ferret as FerretId).catch(() => undefined);
      if (harness?.deliverMedia === undefined) return undefined;
      const [where] = await harness.deliverMedia([{ name, contents: bytes }]).catch(() => []);
      return where;
    };
    const deps = {
      secrets: kernel.secrets,
      fetch: kernel.fetch,
      config,
      ledger: new SpendLedger(kernel.state),
      asks: needs.asks,
      now: () => new Date(kernel.clock.nowMs()),
      deliver,
      serial: serialQueue(),
    };
    const generateImage = generateImageTool(deps);
    const audio = generateAudioTools(deps);
    /** A tool is a ferret's: the owner's own call has no ferret to hand the file to. */
    const forFerret =
      (run: (ferret: string, input: unknown) => Promise<ToolAnswer>) =>
      async (call: Parameters<typeof ferretOf>[0], input: unknown): Promise<ToolAnswer> => {
        const ferret = ferretOf(call);
        if (ferret === undefined)
          return {
            text: 'Making media needs the credential Ferretry gives each ferret; run it from inside a ferret.',
            isError: true,
          };
        return await run(ferret, input);
      };
    return {
      tools: {
        generate_image: forFerret(generateImage),
        generate_speech: forFerret(audio.generate_speech),
        generate_sfx: forFerret(audio.generate_sfx),
        generate_music: forFerret(audio.generate_music),
      },
      hooks: {
        'ask.sources:create-spend': { schema: CreateSpendRefSchema, title: 'Spend on a creative tool', form: false },
      },
    };
  },
});
