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
  /**
   * A credential as a file ALREADY ON DISK once held it, past the stored-secret rule the schema now applies on write: the
   * defensive layers (the probe, the list view) must still behave on a value such a file might hold.
   */
  parseOnDisk(input: Record<string, unknown>): Credential {
    const harness = input.harness === 'claude' || input.harness === undefined ? 'claude-code' : input.harness;
    const { env, ...rest } = input;
    return credentialOf({ ...LoginFileSchema.parse({ ...rest, harness }), env: env as Record<string, string> });
  },
};
