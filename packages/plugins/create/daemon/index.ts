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
import { generateImageTool, type DeliverPicture } from './lib/generate-image.ts';
import { SpendLedger } from './lib/spend.ts';

const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Create (daemon half): the agent tools that make media for a ferret that cannot, spending the owner's own key
 * through the kernel (it places `FAL_KEY`; this plugin never holds it) under a daily cap and an ask over a limit.
 *
 * THE PICTURE reaches the chat with no step by the ferret: Ferrets' `deliverMedia` seam writes it into the ferret's own
 * `media/` folder (`FY_MEDIA_DIR`), and the answer is one block to paste (`src: media:<name>`) under a cost line.
 */
export default implementDaemon(manifest, {
  build({ kernel, needs }) {
    // A day is counted in the file's `timeZone`, else the host's own: the rule Usage's days follow.
    const config = (): ResolvedCreateConfig => {
      const file = kernel.config.file(CreateConfigFile) ?? CreateConfigSchema.parse({});
      return { ...file, timeZone: file.timeZone ?? hostTimeZone() };
    };
    const deliver: DeliverPicture = async (ferret, name, bytes) => {
      const harness = await needs.ferrets.harness?.(ferret as FerretId, ferret as FerretId).catch(() => undefined);
      if (harness?.deliverMedia === undefined) return undefined;
      const [where] = await harness.deliverMedia([{ name, contents: bytes }]).catch(() => []);
      return where;
    };
    const generateImage = generateImageTool({
      secrets: kernel.secrets,
      fetch: kernel.fetch,
      config,
      ledger: new SpendLedger(kernel.state),
      asks: needs.asks,
      now: () => new Date(kernel.clock.nowMs()),
      deliver,
    });
    return {
      tools: {
        generate_image: async (call, input) => {
          const ferret = ferretOf(call);
          if (ferret === undefined)
            return {
              text: 'Making a picture needs the credential Ferretry gives each ferret; run it from inside a ferret.',
              isError: true,
            };
          return await generateImage(ferret, input);
        },
      },
      hooks: {
        'ask.sources:create-spend': { schema: CreateSpendRefSchema, title: 'Spend on a picture', form: false },
      },
    };
  },
});
