import { implementDaemon } from '@ferretry/kernel/manifest';
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
          const logins = ctx.uses.logins.current();
          if (input.login === undefined || logins === undefined)
            return { allow: false, reason: 'Choose an API-key or endpoint login for OpenCode' };
          const reason = await logins.launchRefusal(input.login, input.harness);
          if (reason !== undefined) return { allow: false, reason };
          if (input.fast === true)
            return { allow: false, reason: 'OpenCode does not offer Ferretry fast mode', code: 'unservable_model' };
          return { allow: true };
        },
      },
    };
  },
});
