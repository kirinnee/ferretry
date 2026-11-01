import { FyHttpError } from '@ferretry/protocol/client';
import {
  AccountIdSchema,
  LOGIN_METHODS,
  LOGIN_PASSWORD_MAX_LENGTH,
  LOGIN_PASSWORD_MIN_LENGTH,
  type LoginMethod,
  LoginMethodChangeSchema,
  LoginMethodKindSchema,
  LoginRecipeProposalIdSchema,
  namesPasskey,
  normalizedLoginDomain,
  type Place,
  PlaceSchema,
  SignInIdSchema,
  TwoFactorIdSchema,
} from '@ferretry/protocol';

/** An account's handle (`SUDO_KIRIN_BOX`), checked before anything is sent. */
export function accountHandle(value: string): string {
  const parsed = AccountIdSchema.safeParse(value.trim());
  if (!parsed.success)
    throw new Error(
      `"${value}" is not a usable account handle: use uppercase letters, digits and underscores, like SUDO_KIRIN_BOX (see \`account ls\`)`,
    );
  return parsed.data;
}

/** A sign-in's id (`si_…`), as `account ls` and `account site ls` print it. */
export function signInHandle(value: string): string {
  const parsed = SignInIdSchema.safeParse(value.trim());
  if (!parsed.success)
    throw new Error(`"${value}" is not a sign-in id: they look like si_0123456789abcdef (see \`account site ls\`)`);
  return parsed.data;
}

/** A 2FA key's id (`tf_…`), as `account factor ls` prints it. */
export function factorHandle(value: string): string {
  const parsed = TwoFactorIdSchema.safeParse(value.trim());
  if (!parsed.success)
    throw new Error(`"${value}" is not a 2FA key id: they look like tf_0123456789ab (see \`account factor ls\`)`);
  return parsed.data;
}

export function proposalHandle(value: string): string {
  const parsed = LoginRecipeProposalIdSchema.safeParse(value.trim());
  if (!parsed.success) throw new Error(`"${value}" is not a proposal id: they look like rp_0123456789abcdef`);
  return parsed.data;
}

export function oneLine(value: string, name: string, maximum: number): string {
  const text = value.trim();
  if (text === '' || text.length > maximum || /[\p{Cc}\p{Cf}]/u.test(text))
    throw new Error(`${name} must be one line of 1 to ${String(maximum)} characters`);
  return text;
}

export function onOrOff(value: string): boolean {
  const word = value.trim().toLowerCase();
  if (word === 'on') return true;
  if (word === 'off') return false;
  throw new Error('--auto-apply-recipe is on or off');
}

/** Said without the value: a problem with a typed password never repeats what was typed. */
export function passwordProblem(value: string): string | undefined {
  if (value.length < LOGIN_PASSWORD_MIN_LENGTH)
    return `a saved password must be at least ${String(LOGIN_PASSWORD_MIN_LENGTH)} characters: a shorter one cannot be masked out of output safely`;
  if (value.length > LOGIN_PASSWORD_MAX_LENGTH)
    return `a saved password is at most ${String(LOGIN_PASSWORD_MAX_LENGTH)} characters`;
  if (/\p{Cc}/u.test(value)) return 'a password with a control character or line break would press keys';
  return undefined;
}

function webHosts(values: readonly string[]): string[] {
  return values.map(value => {
    const host = normalizedLoginDomain(value);
    if (host === undefined) throw new Error(`"${value}" is not a web host, like accounts.google.com`);
    return host;
  });
}

/** The flags that name where a sign-in happens. */
export interface PlaceFlags {
  /** Site: where the sign-in happens (login domains), repeatable. */
  readonly domain?: readonly string[] | undefined;
  /** Site: what it is for (hosts the work is on), repeatable. */
  readonly for?: readonly string[] | undefined;
  /** Terminal: the program at the prompt. */
  readonly tool?: string | undefined;
  /** Terminal: the machine the prompt runs on. */
  readonly host?: string | undefined;
  /** Terminal: ssh, scp and sftp only, where it goes. */
  readonly dest?: string | undefined;
}

export const namesPlace = (flags: PlaceFlags): boolean =>
  flags.domain !== undefined ||
  flags.for !== undefined ||
  flags.tool !== undefined ||
  flags.host !== undefined ||
  flags.dest !== undefined;

/**
 * The place the flags name, over the place the sign-in has now (`current`, for an edit): a site flag replaces that
 * list and keeps the other; a terminal flag replaces that field and keeps the rest. A site cannot become a terminal
 * (or back) by an edit: remove it and add the other.
 */
export function placeOf(flags: PlaceFlags, current?: Place): Place {
  const site = flags.domain !== undefined || flags.for !== undefined;
  const terminal = flags.tool !== undefined || flags.host !== undefined || flags.dest !== undefined;
  if (site && terminal)
    throw new Error('a sign-in is on a site (--domain, --for) or in a terminal (--tool, --host, --dest), not both');
  if (current?.kind === 'terminal' && site)
    throw new Error('that sign-in is in a terminal: --domain and --for are for a site (remove it and add one)');
  if (current?.kind === 'site' && terminal)
    throw new Error('that sign-in is on a site: --tool, --host and --dest are for a terminal (remove it and add one)');
  const place = site
    ? {
        kind: 'site' as const,
        domains:
          flags.domain === undefined ? (current?.kind === 'site' ? [...current.domains] : []) : webHosts(flags.domain),
        match: flags.for === undefined ? (current?.kind === 'site' ? [...current.match] : []) : webHosts(flags.for),
      }
    : terminal
      ? {
          kind: 'terminal' as const,
          tool: (flags.tool ?? (current?.kind === 'terminal' ? current.tool : '')).trim().toLowerCase(),
          host: (flags.host ?? (current?.kind === 'terminal' ? current.host : '')).trim().toLowerCase(),
          ...(flags.dest === undefined
            ? current?.kind === 'terminal' && current.dest !== undefined
              ? { dest: current.dest }
              : {}
            : { dest: flags.dest.trim().toLowerCase() }),
        }
      : undefined;
  if (place === undefined)
    throw new Error(
      'say where it signs in: --domain <host> (and --for <host>) for a site, or --tool <program> --host <machine> for a terminal',
    );
  const parsed = PlaceSchema.safeParse(place);
  if (!parsed.success) throw new Error(parsed.error.issues.map(issue => issue.message).join('; '));
  return parsed.data;
}

/** The method flags. */
export interface MethodFlags {
  readonly method?: string | undefined;
  readonly ssoName?: string | undefined;
  /** `--via ID` is the provider's account handle; `--no-via` is `false`. */
  readonly via?: string | false | undefined;
}

/** The method flags, over what the sign-in has now: `--via` alone keeps the method, `--method` alone keeps a via. */
export function methodOf(current: LoginMethod | undefined, options: MethodFlags): LoginMethod | undefined {
  if (options.method === undefined && options.ssoName === undefined && options.via === undefined) return undefined;
  if (options.method !== undefined && namesPasskey(options.method))
    throw new Error('passkeys are off: a sign-in uses a password or a provider (google, github, ...)');
  const kind = LoginMethodKindSchema.safeParse((options.method ?? current?.kind ?? 'password').trim().toLowerCase());
  if (!kind.success) throw new Error(`--method is one of ${LOGIN_METHODS.join(', ')}`);
  if (options.via !== undefined && options.via !== false && kind.data === 'password')
    throw new Error('--via is for a provider method: add --method google (or github, microsoft, apple, sso)');
  const via = options.via === false ? undefined : options.via === undefined ? current?.via : accountHandle(options.via);
  const name = options.ssoName ?? (kind.data === 'sso' ? current?.name : undefined);
  const parsed = LoginMethodChangeSchema.safeParse({
    kind: kind.data,
    ...(name === undefined ? {} : { name: name.trim() }),
    ...(via === undefined || kind.data === 'password' ? {} : { via }),
  });
  if (!parsed.success) throw new Error(parsed.error.issues.map(issue => issue.message).join('; '));
  return parsed.data;
}

/** The owner's words for what the daemon refused about a recipe, by its code. */
export function recipeRefusal(error: unknown): unknown {
  if (!(error instanceof FyHttpError)) return error;
  if (error.code === 'recipe_holds_value')
    return new Error(
      'that recipe holds a saved or vaulted value, which a recipe never may: name the account with [[ID]] and describe the step instead. Nothing was changed',
    );
  if (error.code === 'stale_proposal')
    return new Error(
      'the recipe changed after the ferret proposed this one, so approving it would undo that change unseen: decline it (`site recipe decline`) or edit the recipe yourself',
    );
  if (error.code === 'unknown_proposal')
    return new Error('there is no such proposal: it was already answered or replaced (see `account site recipe show`)');
  return error;
}
