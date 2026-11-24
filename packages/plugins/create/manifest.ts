import { AskSources, AsksPort, type SourceKey } from '@ferretry/core-asks/contract';
import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { cap } from '@ferretry/core-gate/contract';
import { definePlugin, tool } from '@ferretry/kernel/manifest';
import {
  CREATE_AUDIT,
  CREATE_SPEND_SOURCE,
  CREATE_WORDS,
  CreateConfigDef,
  CreateSpendRefSchema,
  GenerateImageInputSchema,
  CREATE_GUARD,
  SPEND_LEDGER,
} from './contract/index.ts';

/**
 * Create (&F6407): creative tools for agents that cannot make media themselves. This is the core: the price table, the
 * spend ledger, the daily cap and the ask over a limit, with `generate_image` through fal as the first tool. Speech,
 * sound, video and a longer-lived media route are the units after it.
 *
 * THE KEY. `FAL_KEY` is a Vault secret named only by this plugin's own `create.yaml` (`fal.key: ${secret:FAL_KEY}`,
 * added by the owner), and the kernel places it on the one request (`kernel.secrets.send`), to the two hosts named
 * below, exactly. Create never holds it; no route, tool answer or ledger line carries it.
 *
 * THE LIMITS (owner, !A616): $5 a day in all, refused past it; one call over $1 asks the owner on the agenda and
 * waits for the owner (the existing Asks path, source `create-spend`); a call whose price cannot be read is refused.
 */
export default definePlugin({
  id: 'create',
  title: 'Create',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  words: CREATE_WORDS,

  // Ferrets: the one seam that hands a ferret a file. Asks: the ask the owner answers.
  needs: { ferrets: FerretsPort, asks: AsksPort },
  provides: {},

  actions: {
    agentTools: [
      tool('generate_image', {
        minimum: 'authenticated',
        caller: 'any',
        capability: cap('fleet', 'use'),
        audit: CREATE_AUDIT,
        guard: CREATE_GUARD,
        input: GenerateImageInputSchema,
        summary:
          'Make one picture from a written description with fal (flux-schnell by default). It is priced before it is sent; over the owner’s one-call limit it asks them first.',
      }),
    ],
  },

  data: {
    state: [SPEND_LEDGER],
    config: [CreateConfigDef],
  },

  // What was spent is the owner's to read, never a ferret's to edit.
  privacy: { private: ['ledger.jsonl'] },

  hooks: {
    takes: [{ hook: AskSources, key: CREATE_SPEND_SOURCE as SourceKey, schema: CreateSpendRefSchema }],
  },

  permissions: {
    // The key is only ever placed on the first two hosts; the CDN is a wildcard, which the kernel never lets a key reach.
    network: ['fal.run', 'api.fal.ai', '*.fal.media'],
    secrets: ['FAL_KEY'],
  },
});
