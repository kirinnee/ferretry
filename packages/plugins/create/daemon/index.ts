import { ferretOf } from '@ferretry/core-gate/contract';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { CreateConfigFile, CreateConfigSchema, CreateSpendRefSchema } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { generateImageTool, type DeliverPicture } from './lib/generate-image.ts';
import { SpendLedger } from './lib/spend.ts';

/**
 * Create (daemon half): the agent tools that make media for a ferret that cannot, spending the owner's own key
 * through the kernel (it places `FAL_KEY`; this plugin never holds it) under a daily cap and an ask over a limit.
 *
 * DECLARED GAP: a plugin cannot write a ferret's MEDIA folder (the `sessions` root is Ferrets' alone), so a picture
 * is handed to the ferret through the one seam that exists for handing a ferret files, its `attachments/` folder,
 * and the tool tells the ferret to `cp` it into `$FY_MEDIA_DIR` for the chat to show it. A Ferrets seam that writes
 * the media folder directly would remove that step.
 */
export default implementDaemon(manifest, {
  build({ kernel, needs }) {
    const config = () => kernel.config.file(CreateConfigFile) ?? CreateConfigSchema.parse({});
    const deliver: DeliverPicture = async (ferret, name, bytes) => {
      const harness = await needs.ferrets.harness?.(ferret as FerretId, ferret as FerretId).catch(() => undefined);
      if (harness?.deliverFiles === undefined) return undefined;
      const [where] = await harness.deliverFiles([{ name, folder: 'create', contents: bytes }]).catch(() => []);
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
