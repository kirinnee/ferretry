/**
 * The in-process door to login changes (`LoginChangesPort`): the same service the `/v1/logins/changes` routes use, with
 * the same input rules. The route parses its body with `LoginChangeSchema`; this door parses what it is handed with the
 * same schema, so a label, variable name or value the route refuses is refused here in the same words and a caller
 * cannot stage what the wire cannot.
 */
import { type LoginChangesApi, LoginChangeError, LoginChangeSchema } from '../../../contract/index.ts';
import type { LoginChangeService } from './service.ts';

export function loginChangesPort(service: Pick<LoginChangeService, 'stage' | 'apply'>): LoginChangesApi {
  return {
    stage: async (change, options) => {
      const parsed = LoginChangeSchema.safeParse(change);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined || issue.path.length === 0 ? 'change' : issue.path.join('.');
        throw new LoginChangeError(
          'login_change_refused',
          `the change is invalid — ${where}: ${issue?.message ?? 'it is not valid'}`,
        );
      }
      return await service.stage(parsed.data, options);
    },
    apply: id => service.apply(id),
  };
}
