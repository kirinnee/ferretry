import { type Credential, credentialIssues, credentialOf } from '../../daemon/lib/shared/credential.ts';
import { LoginFileSchema } from '../../contract/index.ts';

/**
 * What the tests below were written against: a credential parsed from its plain value. A login is now a
 * `LoginFile` (`claude-code`, not `claude`) turned into the daemon's `Credential`; this keeps the old call shape.
 */
export const CredentialSchema = {
  parse(input: Record<string, unknown>): Credential {
    const harness = input.harness === 'claude' || input.harness === undefined ? 'claude-code' : input.harness;
    const credential = credentialOf(LoginFileSchema.parse({ ...input, harness }));
    const issues = credentialIssues(credential);
    if (issues.length > 0) throw new Error(issues.join('; '));
    return credential;
  },
};
