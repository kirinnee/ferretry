/**
 * Where one account's provider credential comes from — and therefore whether a login applies to it.
 *
 * ## The rule this exists to enforce
 *
 * A login control that cannot succeed is worse than no control. If an account's credential arrives
 * from a file the wrapper sources, or from a variable the wrapper reads out of its environment, then
 * **there is nothing to log in to**: the harness will read that value and never consult its own
 * credential store, so a login would open a browser, write a store nobody reads, and leave the
 * account exactly as it was. So the source decides, and the three answers are three different
 * sentences a person needs to see rather than one greyed-out button.
 *
 * ## Read from the DECLARATION, never from the host
 *
 * Everything here is derived from the resolved configuration: the composed environment of the account
 * and whether the fleet declares a secrets file. Nothing is read from disk, no process is launched,
 * and no credential is touched — the same discipline `./identity.ts` keeps for classification. A
 * derivation that stat-ed the secrets file would answer a different question ("is the secret there
 * right now") and would answer it differently on every boot.
 *
 * ## The answer to "no login wanted"
 *
 * `secret-store` is the member a profile earns. A configured value naming `${secret:NAME}` means the
 * credential is in this daemon's own store and the daemon puts it into the launch environment — so
 * there is nothing to sign in to, nothing in the generated wrapper, and nothing in the fleet
 * configuration but a name. It is asked before every other reading of a value, because every other
 * reading would name the wrong place: `configured-value` would say the configuration carries the key,
 * and `environment` would send somebody to a variable they are supposed to set themselves.
 *
 * ## Why an env reference plus a secrets file is a FILE and not the environment
 *
 * `./wrappers.ts` renders a configured value of exactly `$NAME` as `"${NAME}"` and, when the fleet
 * declares one, sources the secrets file before the exports. The guard it emits says so in the
 * wrapper's own words — `expected it from <secretsFile>`. So the file is where the value comes from,
 * and naming the environment there would send somebody to look in the wrong place. Without a declared
 * secrets file the same reference resolves from whatever environment launched the wrapper, which is
 * the other answer.
 *
 * ## `auth` is declared, and it is not the whole answer
 *
 * `auth: 'api-key'` means a login never applies: `decideIdentity` already refuses to read anything for
 * such an identity. But `auth: 'oauth'` does not by itself mean a login applies — an OAuth account
 * whose configuration exports `ANTHROPIC_AUTH_TOKEN` is authenticated by that token, whatever the
 * declaration says about the shape of it. That is not inference about `auth`: it is reading what the
 * generated wrapper will actually export, which is the thing that decides what the harness does.
 */
import { secretReferencesIn, type SecretName } from '@ferretry/protocol';
import type { HarnessKind } from './manifest.ts';
import type { ResolvedAccount } from './profiles.ts';
import { envReferenceName } from './wrappers.ts';
import {
  HARNESS_LOGIN_DECLARATIONS,
  type HarnessLoginDeclarations,
  harnessDoesInteractiveLogin,
  harnessNoLoginReason,
} from './harness-login.ts';

/**
 * Variables that carry a provider CREDENTIAL, per harness.
 *
 * Deliberately narrower than `INHERITED_HARNESS_ENV` in `./harness-env.ts`, which also strips base
 * URLs, session markers and model defaults. Those matter for contamination and none of them is a
 * credential: an account that declares `ANTHROPIC_BASE_URL` and nothing else still gets its
 * credential from a login, and calling that "configured" would hide the login it needs.
 *
 * Annotated over every harness kind, so a new harness cannot be added without deciding which of its
 * variables would stand in for a login.
 */
export const HARNESS_CREDENTIAL_ENV: Readonly<Record<HarnessKind, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
};

/**
 * Where the credential comes from.
 *
 * `undeclared` is the fail-closed member and it is not the same as any of the others: the account
 * declares that it authenticates with a key and its configuration says nowhere the key comes from.
 * Collapsing that into `interactive-login` would offer a login for an API-key account, and collapsing
 * it into `environment` would name a variable nobody declared.
 */
export type FleetCredentialSource =
  /** The harness's own login writes the credential into the harness's own store. */
  | { readonly source: 'interactive-login' }
  /**
   * A profile binds the variable to Ferretry's own secret store, and the daemon supplies the value
   * at launch. This is the "no login wanted" answer: nothing to sign in to, and nothing on disk.
   */
  | { readonly source: 'secret-store'; readonly variable: string; readonly secrets: readonly SecretName[] }
  /** A shell file the generated wrapper sources supplies the variable. */
  | { readonly source: 'token-file'; readonly variable: string; readonly path: string }
  /** The environment that launches the wrapper supplies the variable. */
  | { readonly source: 'environment'; readonly variable: string }
  /** The fleet configuration carries the value itself, and the wrapper exports it as a literal. */
  | { readonly source: 'configured-value'; readonly variable: string }
  /** This account authenticates with a key and nothing declares where the key comes from. */
  | { readonly source: 'undeclared' };

/**
 * The credential variable this account's configuration declares, if any, in the harness's own order.
 *
 * First match wins, and the order is the declaration order in {@link HARNESS_CREDENTIAL_ENV} rather
 * than the configuration's key order: two credential variables on one account is a configuration
 * nobody should write, and a reading that depended on object key order would report it differently
 * on two hosts that declared the same thing.
 */
function declaredCredentialVariable(account: ResolvedAccount): string | undefined {
  return HARNESS_CREDENTIAL_ENV[account.kind].find(name => account.env[name] !== undefined);
}

/**
 * Where this account's credential comes from.
 *
 * `secretsFile` is the fleet's declared one — `FleetConfig.secretsFile` — and absent means the
 * generated wrapper sources nothing.
 */
export function credentialSourceOf(account: ResolvedAccount, secretsFile?: string): FleetCredentialSource {
  const variable = declaredCredentialVariable(account);
  if (variable === undefined) {
    return account.auth === 'api-key' ? { source: 'undeclared' } : { source: 'interactive-login' };
  }
  // Present because `declaredCredentialVariable` found it; read again rather than threaded through so
  // this function has one source of truth for the value it classifies.
  const value = account.env[variable] ?? '';
  // Asked FIRST, because a secret reference is a value the wrapper never carries and never resolves
  // for itself. Reading it as a `configured-value` would report the credential as living in the fleet
  // configuration — which is exactly the sentence a profile exists to stop being true.
  const secrets = secretReferencesIn(value);
  if (secrets.length > 0) return { source: 'secret-store', variable, secrets };
  if (envReferenceName(value) === undefined) return { source: 'configured-value', variable };
  return secretsFile === undefined
    ? { source: 'environment', variable }
    : { source: 'token-file', variable, path: secretsFile };
}

/** Whether a login applies to this account, and — when it does not — which rule refused. */
export type FleetLoginApplicability =
  | { readonly applies: true }
  | {
      readonly applies: false;
      /**
       * `harness-has-no-login` is a fact about the tool; `credential-is-not-a-login` is a fact about
       * this account. They are kept apart because they send a reader to two different places: the
       * first to whatever authenticates that harness, the second to the file or variable named
       * alongside it.
       */
      readonly because: 'harness-has-no-login' | 'credential-is-not-a-login';
      /** Present only when the harness itself declines. The harness's own declared sentence. */
      readonly harnessReason?: string;
    };

/**
 * Decide whether a login applies.
 *
 * The harness is asked first, because a harness with no interactive login offers nothing for any
 * account whatever its credential source is. The source is asked second. Either way the caller still
 * holds the {@link FleetCredentialSource} it passed in, so a refusal can always say where the
 * credential DOES come from — which is the whole reason both facts travel together.
 */
export function decideLoginApplicability(
  kind: HarnessKind,
  source: FleetCredentialSource,
  declarations: HarnessLoginDeclarations = HARNESS_LOGIN_DECLARATIONS,
): FleetLoginApplicability {
  if (!harnessDoesInteractiveLogin(kind, declarations)) {
    const harnessReason = harnessNoLoginReason(kind, declarations);
    return {
      applies: false,
      because: 'harness-has-no-login',
      ...(harnessReason === undefined ? {} : { harnessReason }),
    };
  }
  return source.source === 'interactive-login'
    ? { applies: true }
    : { applies: false, because: 'credential-is-not-a-login' };
}
