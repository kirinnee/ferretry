/**
 * Fakes for the Vault's daemon tests (today's `tests/unit/runtime/mounts/support.ts` and `tests/unit/speedups/fakes.ts`,
 * the secret parts, copied).
 */
import type { ChildEnvironmentOpener } from '@ferretry/kernel/contract';
import type { OutboundHttpRequest, SecretName } from '../../../contract/index.ts';
import type { OutboundOutcome, OutboundTransport, SecretValueSource } from '../../../daemon/lib/secrets/authorizer.ts';
import {
  type SecretChildOutcome,
  type SecretChildRunner,
  type SecretChildSpec,
  type SecretCipherPort,
  type SecretDocumentStore,
  SecretStoreError,
  type SecretVaultDocument,
} from '../../../daemon/lib/secrets/types.ts';

/** A cipher that reverses the text and files the name as the iv: enough to prove AAD and round trips. */
export class FakeSecretCipher implements SecretCipherPort {
  readonly algorithm = 'FAKE-REVERSED';

  async seal(name: SecretName, plaintext: string): Promise<{ readonly iv: string; readonly ciphertext: string }> {
    return { iv: name, ciphertext: [...plaintext].reverse().join('') };
  }

  async #open(name: SecretName, sealed: { readonly iv: string; readonly ciphertext: string }): Promise<string> {
    if (sealed.iv !== name) throw new SecretStoreError('undecipherable', `${name} was filed under ${sealed.iv}`);
    return [...sealed.ciphertext].reverse().join('');
  }

  async openAll(
    entries: Readonly<Record<SecretName, { readonly iv: string; readonly ciphertext: string }>>,
  ): Promise<ReadonlyMap<SecretName, string>> {
    const opened = new Map<SecretName, string>();
    for (const [name, sealed] of Object.entries(entries)) opened.set(name, await this.#open(name, sealed));
    return opened;
  }
}

export class MemorySecretDocuments implements SecretDocumentStore {
  private document: SecretVaultDocument | undefined;

  constructor(private readonly failure?: SecretStoreError) {}

  async read(): Promise<SecretVaultDocument | undefined> {
    if (this.failure !== undefined) throw this.failure;
    return this.document;
  }

  async write(document: SecretVaultDocument): Promise<void> {
    this.document = document;
  }
}

/**
 * Stands in for the kernel's spawn: it opens the environment handle exactly as the kernel's adapter does (with the
 * Vault's opener), then answers what `stdout` makes of it. `opened` is what the child would have been given.
 */
export class EchoSecretChildRunner implements SecretChildRunner {
  spec: SecretChildSpec | undefined;
  opened: Readonly<Record<string, string>> | undefined;

  constructor(
    private readonly opener: ChildEnvironmentOpener,
    private readonly stdout: (env: Readonly<Record<string, string>>) => string = env => JSON.stringify(env),
  ) {}

  async run(spec: SecretChildSpec): Promise<SecretChildOutcome> {
    this.spec = spec;
    this.opened = this.opener.open(spec.env) ?? {};
    return { outcome: 'exited', exitCode: 0, stdout: this.stdout(this.opened), stderr: '', truncated: false };
  }
}

export class FixedVault implements SecretValueSource {
  opened = 0;

  constructor(private readonly entries: Readonly<Record<string, string>> | Error = {}) {}

  async values(): Promise<ReadonlyMap<string, string>> {
    this.opened += 1;
    if (this.entries instanceof Error) throw this.entries;
    return new Map(Object.entries(this.entries));
  }
}

export class RecordingTransport implements OutboundTransport {
  readonly sent: OutboundHttpRequest[] = [];

  constructor(private readonly outcome: OutboundOutcome = { kind: 'completion', payload: { ok: true } }) {}

  async send(request: OutboundHttpRequest): Promise<OutboundOutcome> {
    this.sent.push(request);
    return this.outcome;
  }
}
