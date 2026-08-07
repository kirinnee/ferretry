/**
 * Every document the journey serves, derived from the GENERATED production shell
 * rather than written here.
 *
 * NOTHING IN THIS FILE RETYPES A SECURITY DIRECTIVE, and that is the difference
 * between a proof and a demonstration. The policy is read out of the generated
 * document byte for byte; the probe document is the same bytes with exactly two
 * substitutions — the bootstrap's hash swapped for the probe bootstrap's, and the
 * bootstrap's text swapped for the probe bootstrap's text. Both substitutions are
 * checked by reversing them and comparing against the original, so a
 * "small tidy-up" to a directive cannot pass unnoticed.
 *
 * THE HASH IS TAKEN IN THE GENERATOR'S BYTE ORDER: escape `</script` first, hash
 * the escaped text second. Getting that order wrong produces a document whose
 * script silently never runs, which looks exactly like the engine refusing it —
 * the failure this whole job exists to distinguish. `verifyGeneratorAgreement`
 * closes the duplication by re-deriving the PRODUCTION bootstrap's hash from the
 * generated document and requiring it to be one of the hashes the generated
 * policy already lists.
 *
 * THE DEPLOYED `_headers` RULE IS READ, NOT ASSUMED. Cloudflare Pages appends a
 * matching rule's policy to the `/*` one unless the `!` detach line removes it,
 * and `/*` carries `frame-ancestors 'none'`. A shell served here WITHOUT the
 * deployed rule would be a document that renders in the harness and cannot be
 * framed in production, so a missing rule is a hard failure with the remedy said
 * out loud rather than a green run measuring the wrong document.
 */
import { createHash } from 'node:crypto';

/** The generated shell's own directive, as a `sha256-…` token CSP can carry. */
export const cspHash = (text: string): string => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

/**
 * The generator's escape, reproduced in its exact position in the pipeline.
 *
 * `</script` inside an inline script would close the element early. The backslash
 * is inert in JavaScript — the sequence only occurs inside a string or regex
 * literal — and the HTML parser does not undo it, so the element's text really
 * does contain the backslash and the hash must be taken afterwards.
 */
export const escapeForInlineScript = (source: string): string => source.replace(/<\/(script)/gi, '<\\/$1');

/** `String.replace` treats `$&` in a replacement as a reference; a bundle is full of them. */
const replaceOnce = (haystack: string, needle: string, replacement: string): string =>
  haystack.replace(needle, () => replacement);

export interface GeneratedShell {
  /** The generated document, verbatim. */
  readonly document: string;
  /** The `content="…"` value of the CSP meta element, verbatim. */
  readonly policy: string;
  /** The inline bootstrap's text as the element carries it — already escaped. */
  readonly bootstrap: string;
  /** `cspHash(bootstrap)`, which the policy must already list. */
  readonly bootstrapHash: string;
  /** Every hash the policy's `script-src` lists, in order. */
  readonly scriptHashes: readonly string[];
}

const POLICY_PATTERN = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/;

export const readGeneratedShell = (document: string): GeneratedShell => {
  const policyMatch = POLICY_PATTERN.exec(document);
  const policy = policyMatch?.[1];
  if (policy === undefined)
    throw new Error('❌ the generated shell carries no `<meta http-equiv="Content-Security-Policy">` to read');

  const closers = document.split('</script>').length - 1;
  if (closers !== 1)
    throw new Error(`❌ the generated shell has ${closers} script closers; expected exactly one inline bootstrap`);
  const scriptMatch = /<script>([\s\S]*)<\/script>/.exec(document);
  const bootstrap = scriptMatch?.[1];
  if (bootstrap === undefined || bootstrap.length === 0)
    throw new Error('❌ the generated shell carries no inline bootstrap');

  const scriptSrc = policy.split('; ').find(directive => directive.startsWith('script-src '));
  if (scriptSrc === undefined) throw new Error('❌ the generated policy has no `script-src` directive');
  const scriptHashes = scriptSrc
    .slice('script-src '.length)
    .split(' ')
    .map(source => source.replace(/^'|'$/g, ''));

  return { bootstrap, bootstrapHash: cspHash(bootstrap), document, policy, scriptHashes };
};

/**
 * Proves this file computes the same hash, over the same bytes, in the same order
 * as the generator does — by re-deriving the production bootstrap's hash and
 * requiring the generated policy to already list it.
 *
 * If it does not, every hash below is wrong in the same direction and the probe's
 * script would be refused for a reason that has nothing to do with the engine.
 */
export const verifyGeneratorAgreement = (shell: GeneratedShell): void => {
  if (!shell.scriptHashes.includes(shell.bootstrapHash))
    throw new Error(
      `❌ the hash this harness derives for the generated bootstrap (${shell.bootstrapHash}) is not in the generated policy's script-src (${shell.scriptHashes.join(' ')}). The harness and the generator disagree about the escape or the hash byte order; fix the harness, never the policy.`,
    );
  if (shell.bootstrap.includes('</script'))
    throw new Error('❌ the generated bootstrap carries an unescaped `</script`, which would close its own element');
};

export interface ProbeDocument {
  readonly document: string;
  readonly policy: string;
  /** The probe bootstrap as the element carries it — escaped, then hashed. */
  readonly script: string;
  readonly scriptHash: string;
}

/**
 * The probe document: the generated shell with the smallest possible difference.
 *
 * Two substitutions, both reversed and compared afterwards. The production
 * bootstrap's hash leaves `script-src` and the probe's takes its place; the two
 * library hashes stay exactly where they were, so the probe runs under the same
 * closed script set the product ships and the only thing that changed is WHICH
 * first-party script may run. Every other directive is byte-identical, and
 * `assertOnlyScriptSourcesChanged` proves it rather than claiming it.
 */
export const buildProbeDocument = (shell: GeneratedShell, bundledProbe: string): ProbeDocument => {
  const script = escapeForInlineScript(bundledProbe);
  const scriptHash = cspHash(script);
  const policy = replaceOnce(shell.policy, `'${shell.bootstrapHash}'`, `'${scriptHash}'`);
  if (policy === shell.policy)
    throw new Error('❌ the generated policy did not contain the bootstrap hash token this harness derived');

  const document = replaceOnce(
    replaceOnce(shell.document, shell.policy, policy),
    `<script>${shell.bootstrap}</script>`,
    `<script>${script}</script>`,
  );
  const reversed = replaceOnce(
    replaceOnce(document, policy, shell.policy),
    `<script>${script}</script>`,
    `<script>${shell.bootstrap}</script>`,
  );
  if (reversed !== shell.document)
    throw new Error(
      '❌ the probe document differs from the generated shell somewhere other than its policy and script',
    );

  assertOnlyScriptSourcesChanged(shell.policy, policy, { added: scriptHash, removed: shell.bootstrapHash });
  return { document, policy, script, scriptHash };
};

const QUOTED_SHA256 = /^'sha256-[A-Za-z0-9+/]+={0,2}'$/;

/**
 * Every directive except `script-src` survives byte-identical, and `script-src`
 * differs by exactly one token: the production bootstrap's hash out, the probe
 * bootstrap's hash in.
 *
 * THE STRICTNESS IS THE POINT, and a weaker version of this function is not
 * "good enough because the journey would catch it". A `script-src` check that only
 * required the directive to still be named `script-src` would admit an added
 * `'unsafe-inline'`, `'unsafe-eval'`, `'strict-dynamic'`, `'self'`, a scheme or a
 * host — and while most of those would eventually turn a journey property red,
 * that is a consequence of the journey rather than a property of the document. A
 * reader of this file is entitled to the local guarantee.
 */
export const assertOnlyScriptSourcesChanged = (
  production: string,
  probe: string,
  expected: { readonly removed: string; readonly added: string },
): void => {
  const before = production.split('; ');
  const after = probe.split('; ');
  if (before.length !== after.length)
    throw new Error(`❌ the probe policy has ${after.length} directives; the generated one has ${before.length}`);

  let sawScriptSrc = false;
  before.forEach((directive, index) => {
    const mirror = after[index];
    if (mirror === undefined) throw new Error(`❌ the probe policy is missing directive ${index}`);
    if (!directive.startsWith('script-src ')) {
      if (directive !== mirror)
        throw new Error(`❌ the probe policy changed a non-script directive: "${directive}" became "${mirror}"`);
      return;
    }
    if (!mirror.startsWith('script-src '))
      throw new Error(`❌ the probe policy replaced \`script-src\` with "${mirror}"`);
    sawScriptSrc = true;

    const sources = (directive_: string): readonly string[] => directive_.slice('script-src '.length).split(' ');
    const from = sources(directive);
    const to = sources(mirror);
    if (from.length !== to.length)
      throw new Error(`❌ the probe \`script-src\` lists ${to.length} sources; the generated one lists ${from.length}`);
    const nonHash = to.filter(source => !QUOTED_SHA256.test(source));
    if (nonHash.length > 0)
      throw new Error(`❌ the probe \`script-src\` gained a non-hash source: ${nonHash.join(' ')}`);
    // POSITION BY POSITION, not set against set. Comparing sets would admit a
    // reordered library hash list — same members, different document — and order is
    // part of the bytes this proof claims to have measured.
    const changed = from.flatMap((source, slot) => (to[slot] === source ? [] : [slot]));
    if (changed.length !== 1)
      throw new Error(
        `❌ the probe \`script-src\` differs from the generated one at ${changed.length} positions; exactly one is allowed. generated: ${from.join(' ')} / probe: ${to.join(' ')}`,
      );
    const slot = changed[0] ?? -1;
    if (from[slot] !== `'${expected.removed}'`)
      throw new Error(
        `❌ the probe \`script-src\` changed position ${slot}, which holds ${from[slot]}, not the generated bootstrap hash '${expected.removed}'`,
      );
    if (to[slot] !== `'${expected.added}'`)
      throw new Error(
        `❌ the probe \`script-src\` put ${to[slot]} where the probe bootstrap hash '${expected.added}' belongs`,
      );
  });
  if (!sawScriptSrc) throw new Error('❌ neither policy carries a `script-src` directive to compare');
};

/**
 * The policy control: the probe policy plus one directive.
 *
 * `connect-src 'self'` is WRONG here and the mistake is worth writing down. The
 * frame's origin is opaque, so `'self'` has no origin to match and the fetch
 * would still be refused — producing a control that fails for the same reason the
 * thing it is controlling for fails, which is the one shape a control may never
 * have. The harness origin is therefore named explicitly.
 */
export const withConnectSource = (policy: string, origin: string): string => `${policy}; connect-src ${origin}`;

/** Swaps one policy for another inside a document, refusing if the original is absent. */
export const substitutePolicy = (document: string, from: string, to: string): string => {
  const next = replaceOnce(document, from, to);
  if (next === document) throw new Error('❌ the document does not carry the policy this substitution expected');
  return next;
};

/**
 * A shell whose script cannot run: the generated document with the bootstrap's
 * text replaced by a comment.
 *
 * It is a fixture for the PARENT's handshake timer, and it is derived rather than
 * hand-written so that the document the parent gives up on is the deployed one in
 * every respect except the part that was neutered. The replacement's hash is not
 * in `script-src`, so this incidentally serves a document the engine must refuse.
 */
export const neverReadyDocument = (shell: GeneratedShell): string =>
  replaceOnce(
    shell.document,
    `<script>${shell.bootstrap}</script>`,
    '<script>/* fy-render never-ready probe */</script>',
  );

/** The component that owns the frame; every fact of its is read, never retyped. */
export const PRODUCTION_FRAME_COMPONENT = 'src/components/fy-render-sandbox.tsx';

/** The harness file whose fetch must carry the same options the component's does. */
export const REPLICA_PARENT_SOURCE = 'harness/fy-render-safari/parent.ts';

/**
 * Comments are removed before any source is scanned for code, because a comment
 * that quotes the shape being looked for is exactly what a scanner should not find.
 * The component's header quotes `redirect: 'error'` in prose, one paragraph above
 * the call that uses it.
 */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

/**
 * The option KEYS of the first `await fetch(…, { … })` in a file, at the top level
 * of that object literal.
 *
 * WHY KEYS AND WHY FROM SOURCE. The harness's parent is a replica of the production
 * component's bridge, and a replica whose fetch options have quietly diverged is a
 * replica that measures a request the product does not make. Reading both files and
 * comparing the two sets is a drift gate with no retyping anywhere on either side —
 * and it is the check that would have caught `redirect: 'error'` being added to
 * production while the replica still passed two options.
 *
 * Values are deliberately NOT compared. `signal` names a controller with a
 * different lifetime here (see `parent.ts`), and a value comparison would either
 * fail on that or have to carve out an exception large enough to hide a real change.
 */
export const readFetchOptionKeys = (source: string, path: string): readonly string[] => {
  const code = withoutComments(source);
  const call = code.indexOf('await fetch(');
  if (call === -1)
    throw new Error(
      `❌ could not find an \`await fetch(\` in ${path}. This gate compares the production library fetch with the harness replica of it; if either moved, teach this reader the new shape rather than deleting the comparison.`,
    );
  const open = code.indexOf('{', call);
  if (open === -1) throw new Error(`❌ the \`await fetch(\` in ${path} passes no options object`);

  let depth = 0;
  let body = '';
  for (let index = open; index < code.length; index += 1) {
    const character = code[index];
    if (character === undefined) break;
    // A string literal contributes no key, and skipping it wholesale also keeps a
    // brace or a colon inside a URL from moving the depth counter.
    if (character === "'" || character === '"' || character === '`') {
      index += 1;
      while (index < code.length && code[index] !== character) index += code[index] === '\\' ? 2 : 1;
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) body += character;
  }
  if (depth !== 0) throw new Error(`❌ the \`await fetch(\` options object in ${path} is unterminated`);

  const keys = body
    .split(',')
    .map(part => (part.split(':')[0] ?? '').trim())
    .filter(key => /^[A-Za-z][A-Za-z0-9]*$/.test(key));
  if (keys.length === 0) throw new Error(`❌ the \`await fetch(\` in ${path} passes an empty options object`);
  return [...keys].sort();
};

/**
 * Fails when the replica's library fetch and production's no longer pass the same
 * options.
 *
 * Fail closed, and name both sides: the remedy is always to change the replica,
 * never to relax this. A request made with different options is a different
 * request, and this whole job exists to measure the one the product makes.
 */
export const assertReplicaFetchMatchesProduction = (
  production: readonly string[],
  replica: readonly string[],
): void => {
  if (production.join(' ') === replica.join(' ')) return;
  const missing = production.filter(key => !replica.includes(key));
  const extra = replica.filter(key => !production.includes(key));
  throw new Error(
    `❌ the harness replica's library fetch no longer passes the same options as production. ${PRODUCTION_FRAME_COMPONENT} passes {${production.join(', ')}}; ${REPLICA_PARENT_SOURCE} passes {${replica.join(', ')}}.${missing.length > 0 ? ` Missing from the replica: ${missing.join(', ')}.` : ''}${extra.length > 0 ? ` Only in the replica: ${extra.join(', ')}.` : ''} Change the replica so it makes the request the product makes; do not relax this comparison.`,
  );
};

export interface ProductionFrameContract {
  /** The URL the component sets on the frame, e.g. `/fy-render-sandbox.html`. */
  readonly shellUrl: string;
  /** The exact `sandbox` attribute string the component renders. */
  readonly sandboxAttribute: string;
}

/**
 * The two facts about the production frame this proof must not retype: which
 * document it loads, and which cage it loads it in.
 *
 * BOTH ARE READ OUT OF THE COMPONENT'S SOURCE. Neither is an exported constant —
 * the URL is module-private and the sandbox string is a JSX attribute — so this
 * reads the file and fails closed if either shape moves. A retyped `allow-scripts`
 * would keep passing on the day production added a flag, which is the one way this
 * whole journey could measure a cage the product does not ship.
 *
 * `allow-same-origin` is refused outright rather than reported: with it the frame
 * holds the app's origin, its storage and a reachable parent document, so every
 * identity check in the journey would be meaningless and a green would be a lie.
 */
export const readProductionFrameContract = (source: string, path: string): ProductionFrameContract => {
  const url = /FY_RENDER_SHELL_URL\s*=\s*'([^']+)'/.exec(source)?.[1];
  if (url === undefined)
    throw new Error(
      `❌ could not read \`FY_RENDER_SHELL_URL\` from ${path}. This proof must serve the document the product loads, never a retyped path; if the component changed shape, teach this reader the new shape.`,
    );
  const sandboxAttribute = /\n\s*sandbox="([^"]+)"/.exec(source)?.[1];
  if (sandboxAttribute === undefined)
    throw new Error(
      `❌ could not read the \`sandbox\` attribute from ${path}. This proof must measure the production cage, never a retyped one.`,
    );
  if (sandboxAttribute.includes('allow-same-origin'))
    throw new Error(
      `❌ the production frame now carries \`allow-same-origin\` ("${sandboxAttribute}"). The origin would no longer be opaque and every identity check in this journey would be meaningless. Refusing to report a green.`,
    );
  return { sandboxAttribute, shellUrl: url };
};

export interface DeployedHeaderRule {
  /** Header name/value pairs, in file order, ready to put on a response. */
  readonly headers: readonly (readonly [string, string])[];
  /** The `! Name` lines, which are Pages directives rather than HTTP headers. */
  readonly detached: readonly string[];
}

/**
 * Reads the dedicated `/fy-render-sandbox.html` rule out of `public/_headers`.
 *
 * FAIL CLOSED, LOUDLY. Without the detach line Cloudflare comma-joins this rule's
 * policy onto the `/*` one, and `/*` carries `frame-ancestors 'none'` — so the
 * deployed shell could not be framed by anything and the feature would be inert.
 * A proof that served the shell without this rule would be measuring a document
 * that cannot ship.
 */
export const readDeployedShellHeaders = (headersFile: string, pattern: string): DeployedHeaderRule => {
  const lines = headersFile.split('\n');
  const start = lines.findIndex(line => line.trimEnd() === pattern);
  if (start === -1)
    throw new Error(
      `❌ ${pattern} has no rule in packages/pwa/public/_headers. Add the dedicated rule — with its \`! Content-Security-Policy\` detach line — before running this proof; without it Cloudflare appends the site policy's \`frame-ancestors 'none'\` and the deployed shell is unframeable.`,
    );

  const headers: (readonly [string, string])[] = [];
  const detached: string[] = [];
  // A blank line ends a rule and a new path pattern starts the next one. A comment
  // is skipped at ANY indentation, including column zero — which is where this
  // repository actually writes them, and where an earlier version of this loop
  // would have treated one as the end of the rule and silently truncated it.
  for (const line of lines.slice(start + 1)) {
    const body = line.trim();
    if (body.length === 0) break;
    if (body.startsWith('#')) continue;
    if (!/^\s/.test(line)) break;
    if (body.startsWith('!')) {
      detached.push(body.slice(1).trim());
      continue;
    }
    const separator = body.indexOf(':');
    if (separator === -1) throw new Error(`❌ ${pattern} rule has a line that is not a header: ${body}`);
    headers.push([body.slice(0, separator).trim(), body.slice(separator + 1).trim()]);
  }

  if (!detached.includes('Content-Security-Policy'))
    throw new Error(
      `❌ the ${pattern} rule does not detach \`Content-Security-Policy\`. Cloudflare would append the site policy, whose \`frame-ancestors 'none'\` makes the shell unframeable; restore the \`! Content-Security-Policy\` line.`,
    );
  if (!headers.some(([name]) => name.toLowerCase() === 'content-security-policy'))
    throw new Error(`❌ the ${pattern} rule detaches the site policy without declaring one of its own`);
  return { detached, headers };
};
