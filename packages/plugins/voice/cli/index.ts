import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import { SttEnhancementRequestSchema, type SttEnhancementResult } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { enhanceRequest, renderEnhancement } from './lib/enhance.ts';

const OK = 0;
const USAGE = 2;

const ENHANCE_ROUTE = 'POST /v1/stt/enhance';

const OVERVIEW =
  'Dictation runs in the browser: this command only sends already-transcribed text to the configured enhancement provider for punctuation, casing and proper-noun cleanup.';

const text = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  return typeof value === 'string' ? value : undefined;
};

const terms = (invocation: VerbInvocation): readonly string[] => {
  const value = invocation.options.term;
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? (value as readonly string[]) : [];
};

/**
 * Voice (cli half, §4.9): `fy voice [enhance] <text…> [--model m] [--term t]… [--context c] [--json]`. `enhance` is the
 * default verb, as `fy stt` was. The request is validated against the wire schema before it reaches the daemon.
 */
export default implementCli(manifest, {
  build: ({ client, io }) => {
    const enhance = async (invocation: VerbInvocation): Promise<number> => {
      let request: ReturnType<typeof enhanceRequest>;
      try {
        request = SttEnhancementRequestSchema.parse(
          enhanceRequest(invocation.args, {
            model: text(invocation, 'model'),
            term: terms(invocation),
            context: text(invocation, 'context'),
          }),
        );
      } catch (error) {
        io.err(`${error instanceof Error ? error.message : 'the request is not valid'}\n${OVERVIEW}`);
        return USAGE;
      }
      const result = await client.call<SttEnhancementResult>(ENHANCE_ROUTE, { body: request });
      io.out(invocation.options.json === true ? JSON.stringify(result, null, 2) : renderEnhancement(result));
      return OK;
    };
    return { verbs: { voice: enhance, 'voice enhance': enhance } };
  },
});
