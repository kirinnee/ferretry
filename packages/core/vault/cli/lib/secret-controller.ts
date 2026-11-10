import {
  MAX_SECRET_VALUE_LENGTH,
  MIN_SECRET_VALUE_LENGTH,
  type SecretSummary,
  SecretNameSchema,
} from '../../contract/index.ts';

/** Where a secret VALUE comes from when one is being stored. Never argv: stdin only. */
export interface SecretValueSource {
  read(): Promise<string>;
}

/** The daemon call `fy secret set` needs: `POST /v1/secrets`. There is no read to add beside it. */
export interface SecretPutGateway {
  put(name: string, value: string): Promise<SecretSummary>;
}

export interface SecretOutput {
  success(message: string): void;
}

function secretName(value: string): string {
  const parsed = SecretNameSchema.safeParse(value.trim());
  if (!parsed.success)
    throw new Error(`"${value}" is not a usable secret name — use uppercase letters, digits and underscores`);
  return parsed.data;
}

/**
 * Drives `fy secret set`.
 *
 * THE VALUE IS NEVER AN ARGUMENT. `fy secret set TOKEN sk-live-…` would put the credential in the shell history of
 * whoever typed it and in `/proc/<pid>/cmdline` for every account on the machine, which is precisely the disclosure
 * this store exists to stop — so that spelling does not exist (S1, S33). The value comes in on stdin through
 * {@link SecretValueSource}, and nothing printed here echoes it: the answer is the name and an instant.
 */
export class SecretController {
  constructor(
    private readonly gateway: SecretPutGateway,
    private readonly out: SecretOutput,
    private readonly values: SecretValueSource,
  ) {}

  async set(name: string): Promise<void> {
    const parsed = secretName(name);
    const value = await this.values.read();
    if (value.length < MIN_SECRET_VALUE_LENGTH)
      throw new Error(
        `a secret must be at least ${MIN_SECRET_VALUE_LENGTH} characters — shorter values cannot be masked out of output safely`,
      );
    if (value.length > MAX_SECRET_VALUE_LENGTH)
      throw new Error(`a secret must be at most ${MAX_SECRET_VALUE_LENGTH} characters`);
    const summary = await this.gateway.put(parsed, value);
    this.out.success(`${summary.name} stored (${summary.updatedAt})`);
  }
}
