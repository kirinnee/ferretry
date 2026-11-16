/**
 * THE HOSTED APP'S ORIGIN: where a pairing link, a published catalog, a share link and the daemon's CORS default point.
 *
 * ONE OWNER. This is the only module in the repository that spells the address. Access, Connections and Logins each
 * used to carry their own copy; they now re-export this one, and `scripts/validate/hosted-app-origin.sh` fails the build
 * when a second literal appears.
 *
 * A BUILD-TIME FACT, like the relay directory origin. `__FY_HOSTED_APP_ORIGIN__` is a build define that both the app
 * build (`packages/app/vite.config.ts`) and the daemon compile (`scripts/release/compile.sh`) set from one script,
 * `scripts/ci/hosted-app-origin.sh`. Nothing defines it by default, so every ordinary build, local run and test reads
 * {@link DEFAULT_HOSTED_APP_ORIGIN}; only a build that names another address (the 5.0 preview) reads that one.
 */

/** The production hosted app. The script reads this line, so it stays one `export const` with an https origin. */
export const DEFAULT_HOSTED_APP_ORIGIN = 'https://ferretry.pages.dev';

/** The build define; absent in an ordinary build, a test and a source run. */
declare const __FY_HOSTED_APP_ORIGIN__: string | undefined;

/**
 * The origin a build carries: the compiled define when it is a plain https origin, else the default. A define that is
 * not one (a path, a credential, another scheme) is ignored rather than trusted, because a link built on it would be
 * handed to a browser launcher; the build script refuses such a value earlier, with its reason.
 */
export function hostedAppOrigin(compiled: string | undefined): string {
  if (compiled === undefined || compiled.trim() === '') return DEFAULT_HOSTED_APP_ORIGIN;
  let url: URL;
  try {
    url = new URL(compiled);
  } catch {
    return DEFAULT_HOSTED_APP_ORIGIN;
  }
  const plain =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  return plain ? url.origin : DEFAULT_HOSTED_APP_ORIGIN;
}

/** The hosted app's origin for THIS build. */
export const HOSTED_APP_ORIGIN = hostedAppOrigin(
  typeof __FY_HOSTED_APP_ORIGIN__ === 'string' ? __FY_HOSTED_APP_ORIGIN__ : undefined,
);
