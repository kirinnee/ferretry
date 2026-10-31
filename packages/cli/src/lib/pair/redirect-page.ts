/**
 * The page `fy pair --open` hands the browser INSTEAD of the pairing link.
 *
 * WHY A PAGE AT ALL. The link's fragment carries the live pairing code, and anything passed to
 * `xdg-open` or `open` lands in a process's argument vector — and from there in the browser's own. On
 * Linux that vector is `/proc/<pid>/cmdline`, readable by every local user, so on a host shared with
 * people who are not trusted the code would be one `ps` away for its whole two-minute life. A file
 * name carries no secret, so the page carries it instead: the browser opens the path, the page's
 * script replaces itself with the link, and the code never appears in anyone's argv.
 *
 * `location.replace` and not an assignment or a `<meta refresh>`, so the page leaves the history: Back
 * from the app does not return to a page that would redirect straight into it again. The fragment
 * survives the replace untouched — it is part of the URL string the script is given.
 *
 * NOTHING ABOUT THE LINK IS TRUSTED INTO MARKUP. The link goes in as a JSON string literal and the
 * characters a script element could be closed or confused by are escaped, so a link that somehow
 * carried `</script>` stays text. It is also refused unless it is `http` or `https`: a `javascript:`
 * URL handed to `location.replace` runs, and a page this command wrote must never be the thing that
 * ran it.
 */

/*
 * What could end a script element (`<`), open an HTML comment inside it (`<`, `>`), start an entity
 * (`&`), or break a line in an engine that treats the two Unicode separators as one. Written as an
 * escaped string so no invisible character sits in this source.
 */
const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/gu;

/** `value` as a JavaScript string literal that is safe inside an inline `<script>`. */
const scriptLiteral = (value: string): string =>
  JSON.stringify(value).replace(
    SCRIPT_UNSAFE,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** The redirect page for `link`, or a refusal when `link` is not an absolute `http`/`https` URL. */
export function renderPairingRedirectPage(link: string): string {
  let protocol: string;
  try {
    protocol = new URL(link).protocol;
  } catch {
    throw new Error('the pairing link is not an absolute URL');
  }
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error('the pairing link must use http or https');
  return `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Opening Ferretry</title>
<p>Opening Ferretry to pair this device&hellip;</p>
<script>location.replace(${scriptLiteral(link)});</script>
`;
}
