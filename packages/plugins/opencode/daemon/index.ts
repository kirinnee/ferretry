import { implementDaemon } from '@ferretry/kernel/manifest';
import { LoginIdSchema } from '@ferretry/plugin-logins/contract';
import manifest from '../manifest.ts';
import { OPENCODE_CONFIG, HarnessConfigSchema } from '../contract/index.ts';
import { opencodeHarness } from './harness.ts';

export default implementDaemon(manifest, {
  build(ctx) {
    const config = () => HarnessConfigSchema.parse(ctx.kernel.config.file(OPENCODE_CONFIG) ?? {});
    return {
      hooks: {
        'harnesses:opencode': opencodeHarness(ctx.kernel, config),
        'start.decide': async input => {
          if (input.harness !== 'opencode') return { allow: true };
          const login =
            input.login === undefined
              ? undefined
              : await ctx.uses.logins.current()?.get(LoginIdSchema.parse(input.login));
          if (login === undefined) return { allow: false, reason: 'Choose an API-key or endpoint login for OpenCode' };
          if (login.store !== 'environment')
            return {
              allow: false,
              reason:
                'OpenCode refuses subscription sign-ins, including Anthropic Claude subscriptions; choose an API key or endpoint login',
            };
          if (input.fast === true)
            return { allow: false, reason: 'OpenCode does not offer Ferretry fast mode', code: 'unservable_model' };
          return { allow: true };
        },
      },
    };
  },
});
