/**
 * Generates the `fy-render` sandbox shell and its two trusted library bundles.
 *
 * Emits three files into `public/`, none of them committed:
 *   - `fy-render-sandbox.html`  the static shell (small, reviewable, hash-pinned)
 *   - `fy-render-mermaid.js`    the Mermaid bundle the PARENT fetches
 *   - `fy-render-lottie.js`     the Lottie light bundle the PARENT fetches
 *
 * HOW LIBRARY CODE REACHES A FRAME THAT MAY NOT FETCH A SUBRESOURCE. The frame's
 * `default-src 'none'` refuses every ordinary subresource, so it cannot carry
 * `<script src>` — a subresource is a request, even to our own origin. That is a
 * narrower claim than "the frame has no network": self-navigation, prerender and
 * WebRTC were all measured egressing from this frame shape, need code running
 * inside it to reach, and are a declared residual in `docs/fy-render.md` gap 2.
 * Instead the parent fetches the one
 * bundle the block actually needs with `credentials: 'omit'` and transfers the
 * bytes over the capability port, and the shell installs them as an inline
 * script.
 *
 * THAT INSTALL PRIMITIVE IS SAFE BECAUSE OF CSP, NOT BECAUSE OF A COMMENT. The
 * shell's `script-src` lists nothing but the SHA-256 of the bootstrap and of
 * these two bundles, computed here at build time. A real-Chromium probe measured
 * the behaviour this depends on inside the opaque frame: a dynamically created
 * inline script whose text matches a pinned hash runs, and the identical
 * primitive with any other text does not. Author bytes therefore cannot become
 * code — not because the shell declines to pass them, but because the browser
 * refuses to run anything whose hash was not fixed at build time.
 *
 * WHY NOT INLINE EVERYTHING INTO THE SHELL. It was built and measured that way
 * first: one 3.5 MB document, which every reader of a Lottie block would have
 * had to download in full to play a 170 KB animation. Splitting the bundles
 * keeps each block's cost proportional, keeps the shell small enough to review
 * by eye, and lets the two vendor files cache independently.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createScanner, LanguageVariant, SyntaxKind, tokenIsIdentifierOrKeyword } from 'typescript/unstable/ast';

const packageRoot = resolve(import.meta.dir, '..');
const shellDirectory = resolve(packageRoot, 'scripts/fy-render-shell');
const publicDirectory = resolve(packageRoot, 'public');

export interface FyRenderShellArtifacts {
  readonly shell: string;
  readonly mermaid: string;
  readonly lottie: string;
}

/**
 * The three generated names, resolved under whichever directory is asked for.
 *
 * WHY THIS TAKES A DIRECTORY. Production writes them into `public/` for Vite and
 * the deploy pipeline, and that is still the default below. The integration
 * fixture CLI writes them into a private `mkdtemp` directory instead, so two
 * builds can never write the same three paths — a hazard the security review
 * named explicitly: `writeFile` is not atomic, so two concurrent builders let a
 * reader observe torn bytes, fail the hash pin, and be told the library did not
 * load.
 */
export const fyRenderShellArtifactsIn = (directory: string): FyRenderShellArtifacts => ({
  lottie: resolve(directory, 'fy-render-lottie.js'),
  mermaid: resolve(directory, 'fy-render-mermaid.js'),
  shell: resolve(directory, 'fy-render-sandbox.html'),
});

/** The production set, so `.gitignore` and `build-pwa.sh` have one place to agree with. */
export const FY_RENDER_SHELL_ARTIFACTS = fyRenderShellArtifactsIn(publicDirectory);

interface Bundle {
  readonly name: string;
  readonly text: string;
  readonly hash: string;
}

const sha256 = (text: string): string => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

const build = async (entry: string): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [resolve(shellDirectory, entry)],
    format: 'iife',
    minify: true,
    // No splitting: a chunk on disk would be a subresource somebody has to fetch
    // separately, and the parent transfers exactly one file per library.
    splitting: false,
    target: 'browser',
  });
  if (!result.success) throw new Error(`❌ ${entry} did not build:\n${result.logs.join('\n')}`);
  const [artifact] = result.outputs;
  if (artifact === undefined) throw new Error(`❌ ${entry} produced no output`);
  return await artifact.text();
};

/**
 * WHY THE DYNAMIC-CODE GUARD PARSES INSTEAD OF MATCHING TEXT.
 *
 * The previous spelling of this guard was four regular expressions over the
 * minified bundle. A regex can only look at the characters immediately around a
 * name, so it read `Function(` the same whether it sat in code, in a string, in
 * a comment or inside a regex literal — and, worse, it could not see the same
 * call written any other way. `globalThis.Function(…)`, `globalThis['Function'](…)`,
 * `obj.constructor?.(…)` and `setExpressionsPlugin?.(…)` all build or invoke
 * exactly what the guard exists to refuse, and every one of them walked straight
 * past it. A guard that a minifier's own output could evade is not a guard.
 *
 * WHY A TOKEN WALK AND NOT A SYNTAX TREE. TypeScript 7's parser is native code:
 * the npm package's JavaScript entry points are `typescript/unstable/sync` and
 * friends, which spawn the Go binary and talk to it over a synchronous stdio
 * channel built on Node internals. Measured here, that channel throws under Bun
 * (`stdout._handle.fd` is undefined), and this generator is a Bun program, so a
 * real `SourceFile` is not available to it. What the same package ships in plain
 * JavaScript is its SCANNER, and that is the part this needs: the ambiguity a
 * regex cannot resolve is lexical, not semantic. Tokenising with the compiler's
 * own lexer keeps strings and regex literals opaque, skips comments, and
 * separates template text from substitution code. A short backward walk over
 * that token stream then reads the callee of each candidate call, `new`, and
 * tagged template.
 *
 * WHAT THAT BUYS, STATED AS NARROWLY AS IT IS TRUE. Occurrences inside strings,
 * comments and regex literals stop the build no longer, because the lexer never
 * hands them out as code. Escape-obfuscated spellings start stopping it, because
 * the lexer decodes them: `globalThis['Function'](…)` and `eval(…)` are
 * `Function` and `eval` by the time this sees them.
 *
 * WHAT IT STILL CANNOT SEE, and these are residuals rather than oversights. A
 * name assembled at runtime (`globalThis['Fun' + 'ction']`) is not a name at build
 * time. An alias (`var e = eval; e(src)`) needs data flow, not syntax. And a
 * dangerous function handed somewhere as a VALUE rather than called
 * (`setTimeout(eval, 0)`) is not an execution site in this sense at all. This
 * refuses spellings, which is a weaker claim than refusing capability, and the
 * absence it backs is still ultimately the `lottie_light` build's own.
 */
interface SourceToken {
  readonly kind: SyntaxKind;
  /** The DECODED identifier or string value; empty for everything else. */
  readonly value: string;
  readonly start: number;
}

/**
 * Tokens a value can end on. This is the whole reason the walk can tell a call
 * from a grouping: `(0, eval)(x)` puts a parenthesised expression before the
 * argument list, while `f(0, eval)(x)` puts a call's RESULT there, and the only
 * difference is the token in front of the opening paren.
 *
 * It also decides whether a `/` opens a regex literal or divides, which no
 * tokeniser can know from the character alone. `}` stays on the value side for
 * that decision: it may end an object, class or function expression. Treating a
 * regex after a statement block as division can only expose its text to a
 * conservative false positive; treating division after an expression as a
 * regex can swallow arbitrary live code before the next slash.
 */
const VALUE_ENDING_TOKENS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.ConstructorKeyword,
  SyntaxKind.ThisKeyword,
  SyntaxKind.SuperKeyword,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateTail,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
]);

const endsAValue = (token: SourceToken | undefined): boolean =>
  token !== undefined && VALUE_ENDING_TOKENS.has(token.kind);

const regexMayFollow = (previous: SourceToken | undefined): boolean =>
  previous === undefined || !VALUE_ENDING_TOKENS.has(previous.kind);

/**
 * The compiler's lexer, driven by hand for the two things it cannot decide on
 * its own: whether a `/` opens a regex, and whether a `}` closes a block or
 * resumes a template literal. Both are decided from the preceding token stream.
 * The one irreducible slash ambiguity is deliberately resolved toward DIVISION
 * after `}`. JavaScript permits `var ratio = {} / 2`; rescanning that slash as a
 * regex can consume real calls up to a later slash. A statement block followed
 * by a regex instead gets tokenised conservatively as code, which may stop the
 * build but cannot hide a call.
 *
 * FAIL-CLOSED ON ITS OWN CONFUSION. If either decision were wrong the scanner
 * would run off into the text and quietly stop seeing code — the one failure
 * mode of this design that hides a call rather than inventing one. An
 * unterminated literal or an `Unknown` token is the signature of exactly that,
 * so both stop the build instead of being scanned past. Both shipped bundles
 * tokenise clean.
 */
const tokenizeJavaScript = (name: string, source: string): readonly SourceToken[] => {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: SourceToken[] = [];
  const braces: ('block' | 'template')[] = [];
  for (;;) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) break;
    const previous = tokens[tokens.length - 1];
    if (kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) {
      if (regexMayFollow(previous)) kind = scanner.reScanSlashToken();
    } else if (kind === SyntaxKind.CloseBraceToken && braces[braces.length - 1] === 'template') {
      braces.pop();
      kind = scanner.reScanTemplateToken(false);
    }
    if (kind === SyntaxKind.OpenBraceToken) braces.push('block');
    else if (kind === SyntaxKind.CloseBraceToken) braces.pop();
    else if (kind === SyntaxKind.TemplateHead || kind === SyntaxKind.TemplateMiddle) braces.push('template');
    if (kind === SyntaxKind.Unknown || scanner.isUnterminated())
      throw new Error(
        `❌ ${name} could not be tokenised at offset ${scanner.getTokenStart()}; the guard cannot see it`,
      );
    const named =
      tokenIsIdentifierOrKeyword(kind) ||
      kind === SyntaxKind.StringLiteral ||
      kind === SyntaxKind.NoSubstitutionTemplateLiteral;
    tokens.push({ kind, start: scanner.getTokenStart(), value: named ? scanner.getTokenValue() : '' });
  }
  return tokens;
};

/**
 * Every `(…)` and `[…]` index mapped to its partner, BOTH ways, computed once
 * forward. The backward walk jumps over groups to find a callee and the forward
 * walk jumps over them to find the end of a `new` target, and re-counting either
 * way at each site would be quadratic on a bundle this size.
 */
const bracketPartners = (tokens: readonly SourceToken[]): ReadonlyMap<number, number> => {
  const partners = new Map<number, number>();
  const open: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === SyntaxKind.OpenParenToken || token.kind === SyntaxKind.OpenBracketToken) open.push(index);
    else if (token.kind === SyntaxKind.CloseParenToken || token.kind === SyntaxKind.CloseBracketToken) {
      const start = open.pop();
      if (start !== undefined) {
        partners.set(index, start);
        partners.set(start, index);
      }
    }
  });
  return partners;
};

interface ExecutionTarget {
  /** The resolved NAME whose capability the call-like site invokes. */
  readonly name: string;
  /** Whether that name was reached through `.`, `?.` or a computed access. */
  readonly viaMember: boolean;
  readonly start: number;
}

/**
 * Built-in function helpers that invoke, or create an invokable binding of,
 * their receiver. `Function.call(…)` has the lexical tail `call`, but the
 * capability being reached is still the statically named `Function` receiver.
 */
const STATIC_RECEIVER_FORWARDERS: ReadonlySet<string> = new Set(['call', 'apply', 'bind']);

/**
 * `a["constructor"]`, ``a[`constructor`]`` and their parenthesised forms name a
 * property statically; `a[k]` does not. Only a string-valued literal yields a
 * name, and the parens are unwrapped because a minifier is free to leave them.
 */
const staticPropertyName = (
  tokens: readonly SourceToken[],
  partners: ReadonlyMap<number, number>,
  from: number,
  to: number,
): string | undefined => {
  let first = from;
  let last = to;
  while (tokens[first]?.kind === SyntaxKind.OpenParenToken && partners.get(last) === first) {
    first += 1;
    last -= 1;
  }
  const only = tokens[first];
  if (
    first !== last ||
    (only?.kind !== SyntaxKind.StringLiteral && only?.kind !== SyntaxKind.NoSubstitutionTemplateLiteral)
  )
    return undefined;
  return only.value;
};

/**
 * Given the index of the LAST token of a callee expression, the name that would
 * actually be invoked — or `undefined` when no name is statically knowable.
 *
 * Usually the tail matters. `globalThis.Function`, `a.b.c.Function` and a bare
 * `Function` all invoke the same thing. The exception is a static
 * `call`/`apply`/`bind` tail: those built-ins invoke, or bind, their RECEIVER, so
 * the walk follows that receiver one step left rather than reporting `call`.
 * The other forms it walks through are the ones a minifier and an attacker both
 * reach for: optional calls (`f?.()`), member and computed access, parentheses,
 * and the comma expression that makes `(0, eval)` an indirect eval.
 */
const executionTargetEndingAt = (
  tokens: readonly SourceToken[],
  partners: ReadonlyMap<number, number>,
  index: number,
): Omit<ExecutionTarget, 'start'> | undefined => {
  const token = tokens[index];
  if (token === undefined) return undefined;
  // `f?.()` — the optional-call marker sits between the callee and its arguments.
  if (token.kind === SyntaxKind.QuestionDotToken) return executionTargetEndingAt(tokens, partners, index - 1);
  if (tokenIsIdentifierOrKeyword(token.kind)) {
    const previous = tokens[index - 1];
    // `function Function(a){}` and `class Function{}` put a parameter list after
    // the name, not an argument list. Declaring something is not calling it.
    if (previous?.kind === SyntaxKind.FunctionKeyword || previous?.kind === SyntaxKind.ClassKeyword) return undefined;
    if (previous?.kind === SyntaxKind.AsteriskToken && tokens[index - 2]?.kind === SyntaxKind.FunctionKeyword)
      return undefined;
    const viaMember = previous?.kind === SyntaxKind.DotToken || previous?.kind === SyntaxKind.QuestionDotToken;
    if (viaMember && STATIC_RECEIVER_FORWARDERS.has(token.value))
      return executionTargetEndingAt(tokens, partners, index - 2);
    return { name: token.value, viaMember };
  }
  if (token.kind === SyntaxKind.CloseBracketToken) {
    const open = partners.get(index);
    if (open === undefined) return undefined;
    // Something has to be indexed for this to be a member access; a bare `[…]`
    // is an array literal, and an array literal is not a callee.
    const before = tokens[open - 1];
    if (!endsAValue(before) && before?.kind !== SyntaxKind.QuestionDotToken) return undefined;
    const name = staticPropertyName(tokens, partners, open + 1, index - 1);
    if (name === undefined) return undefined;
    if (STATIC_RECEIVER_FORWARDERS.has(name))
      return executionTargetEndingAt(
        tokens,
        partners,
        before?.kind === SyntaxKind.QuestionDotToken ? open - 2 : open - 1,
      );
    return { name, viaMember: true };
  }
  if (token.kind === SyntaxKind.CloseParenToken) {
    const open = partners.get(index);
    if (open === undefined) return undefined;
    // `f(x)(y)` calls a RETURN VALUE, and no name describes it. `(0, eval)(y)`
    // and `new (globalThis.Function)(y)` are groupings, and the callee is the
    // last thing inside them — which is exactly the token before the `)`.
    if (endsAValue(tokens[open - 1])) return undefined;
    return executionTargetEndingAt(tokens, partners, index - 1);
  }
  return undefined;
};

/**
 * THE ARGUMENT LIST IS OPTIONAL, WHICH IS WHY THIS WALKS FORWARD.
 *
 * `new Function` constructs without a single parenthesis, and so do
 * `new globalThis.Function`, `new obj["Function"]` and `new (0, Function)`. A
 * detector anchored on an opening paren sees none of them. So a `new` keyword is
 * an execution site in its own right: this returns the index of the LAST token
 * of the constructor expression that follows it, and the same backward resolver
 * reads the name from there.
 *
 * It stops at the argument list on purpose. When one is present the call is
 * already reported by the paren site, and reporting it twice is harmless.
 */
const newTargetEndingAt = (
  tokens: readonly SourceToken[],
  partners: ReadonlyMap<number, number>,
  start: number,
): number | undefined => {
  const first = tokens[start];
  if (first === undefined) return undefined;
  let end: number;
  if (first.kind === SyntaxKind.OpenParenToken) {
    const close = partners.get(start);
    if (close === undefined) return undefined;
    end = close;
  } else if (tokenIsIdentifierOrKeyword(first.kind)) end = start;
  else return undefined;
  for (;;) {
    const next = tokens[end + 1];
    if (next?.kind === SyntaxKind.DotToken || next?.kind === SyntaxKind.QuestionDotToken) {
      const name = tokens[end + 2];
      if (name === undefined || !tokenIsIdentifierOrKeyword(name.kind)) return end;
      end += 2;
    } else if (next?.kind === SyntaxKind.OpenBracketToken) {
      const close = partners.get(end + 1);
      if (close === undefined) return end;
      end = close;
    } else return end;
  }
};

/**
 * Candidate direct execution sites whose tail name is statically knowable: a
 * call, a `new` with or without an argument list, and a tagged template, which
 * invokes its tag exactly as a call would. This lexical walk is deliberately
 * conservative and may also reject a call-shaped method definition; a false
 * positive stops a dependency bump, while an unresolved runtime alias is a
 * declared residual above.
 */
const executionTargets = (name: string, source: string): readonly ExecutionTarget[] => {
  const tokens = tokenizeJavaScript(name, source);
  const partners = bracketPartners(tokens);
  const targets: ExecutionTarget[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === SyntaxKind.NewKeyword) {
      const end = newTargetEndingAt(tokens, partners, index + 1);
      const constructed = end === undefined ? undefined : executionTargetEndingAt(tokens, partners, end);
      if (constructed !== undefined) targets.push({ ...constructed, start: token.start });
      return;
    }
    const previous = tokens[index - 1];
    const tagged =
      (token.kind === SyntaxKind.NoSubstitutionTemplateLiteral || token.kind === SyntaxKind.TemplateHead) &&
      (endsAValue(previous) || previous?.kind === SyntaxKind.QuestionDotToken);
    if (token.kind !== SyntaxKind.OpenParenToken && !tagged) return;
    const target = executionTargetEndingAt(tokens, partners, index - 1);
    if (target !== undefined) targets.push({ ...target, start: token.start });
  });
  return targets;
};

/**
 * Names whose invocation through one of the statically resolved forms above —
 * including a static `call`/`apply`/`bind` receiver — means the expression
 * evaluator is back. Each carries the sentence the build should say when it
 * stops.
 */
const FORBIDDEN_EXECUTION_TARGETS: ReadonlyMap<string, string> = new Map([
  ['Function', '❌ the Lottie bundle regained the Function constructor — the expression evaluator may be back'],
  ['eval', '❌ the Lottie bundle regained `eval`'],
  ['setExpressionsPlugin', '❌ something registered a Lottie expression plugin'],
]);

/**
 * `constructor` is the one name that cannot simply be banned, and the reason is
 * measured rather than assumed: the shipped `lottie_light` bundle contains
 * exactly one `constructor` token, `Z.o.x.constructor===Array`, which reads a
 * property and calls nothing. Refusing the word would fail every build over a
 * type check. Refusing the CALL is the actual invariant — `x.constructor(src)`
 * rebuilds `Function` by another name — and a call is what this sees.
 *
 * It is required to arrive through a member access for the same reason. A class
 * body's `constructor(t){…}` is a definition whose parentheses hold parameters,
 * and no `.` or `?.` or `['constructor']` precedes it; a dynamic reach always
 * has one.
 */
const DYNAMIC_CONSTRUCTOR_REACH =
  '❌ the Lottie bundle reaches a constructor dynamically, which can rebuild `Function`';

const assertNoDynamicCodeExecution = (name: string, source: string): void => {
  for (const target of executionTargets(name, source)) {
    const forbidden = FORBIDDEN_EXECUTION_TARGETS.get(target.name);
    if (forbidden !== undefined) throw new Error(`${forbidden} (at offset ${target.start})`);
    if (target.name === 'constructor' && target.viaMember)
      throw new Error(`${DYNAMIC_CONSTRUCTOR_REACH} (at offset ${target.start})`);
  }
};

/**
 * The invariants that must survive a dependency bump — each scoped to exactly
 * what was measured, and no wider.
 */
const assertInvariants = (name: string, source: string): void => {
  /**
   * Applies to every bundle. A surviving dynamic import is a chunk the frame
   * would have to fetch at runtime, and the frame is allowed no request at all.
   */
  // Token based so legal trivia cannot hide the call as
  // `import/* comment */("./chunk.js")`, and occurrences in strings/comments do
  // not invent one. Static `import` and `import.meta` have no following `(`.
  const tokens = tokenizeJavaScript(name, source);
  if (
    tokens.some(
      (token, index) =>
        token.kind === SyntaxKind.ImportKeyword && tokens[index + 1]?.kind === SyntaxKind.OpenParenToken,
    )
  )
    throw new Error(`❌ ${name} still contains a dynamic import; the frame would have to fetch a chunk`);

  /**
   * Scoped to Lottie ON PURPOSE, because only here is the primitive genuinely
   * absent. The light build ships no expression evaluator, so `"x"` strings in
   * an animation are inert data rather than source text.
   *
   * ANY STATICALLY NAMED DIRECT EXECUTION SITE this walk resolves — not just the
   * `new` form and not just the bare identifier. `Function(src)` without `new`
   * builds exactly the same function and is the spelling this very toolchain
   * emits, and reaching that same constructor as `globalThis['Function']` or as
   * `x.constructor` is the same capability under another name. So the detector
   * resolves the callee rather than matching the characters in front of it.
   *
   * The Mermaid bundle is NOT asserted this way and must not be. Run this same
   * detector over it and the picture is concrete: four bare
   * `Function("return this")` global-lookup fallbacks inherited from lodash and
   * zero `new Function`, seventeen `new x.constructor(…)` clone helpers, and one
   * `(0, eval)(J)` feature probe — a spelling the regex this replaced could not
   * have seen at all, since the `eval` there is followed by `)` and not by `(`.
   * In a browser `self` is defined, so the lodash `||` chain short-circuits and
   * those four never evaluate; and the shell's CSP omits `'unsafe-eval'`, so if
   * any of them were reached the browser would refuse it. That is a
   * short-circuit plus a policy, which is a weaker claim than absence, and it is
   * stated as such rather than folded into this assertion.
   */
  if (name === 'lottie') assertNoDynamicCodeExecution(name, source);
};

/**
 * `</script` inside the bootstrap would close the element early. Breaking it
 * with a backslash is inert in JavaScript — the sequence only ever occurs inside
 * a string or regex literal, where `<\/script` means the same thing — and the
 * hash is taken AFTER this substitution because the HTML parser does not undo
 * it: the script element's text really does contain the backslash.
 */
const escapeForInlineScript = (source: string): string => source.replace(/<\/(script)/gi, '<\\/$1');

/**
 * The policy the shell enforces on itself.
 *
 * `default-src 'none'` denies ORDINARY SUBRESOURCES: fetch, XHR, websocket,
 * worker, nested frame, font, media, remote images. Each addition below is the
 * minimum one library needs.
 *
 * It does NOT make the document incapable of reaching the network. Prior
 * measurement (`self-navigation-result.md`, `sandbox-security-verdict.md`) shows
 * self-navigation, `<link rel=prerender>` and WebRTC STUN/TURN all egress from
 * this exact frame shape under this exact policy, and Chromium does not
 * recognise `webrtc 'block'`. Those channels are reachable only from trusted
 * library code — no author code runs here — but the honest claim is "ordinary
 * subresources are denied", never "there is nothing to navigate to".
 *
 * `script-src` lists only build-time hashes. There is no `'self'`, no
 * `'unsafe-inline'` and no `'unsafe-eval'`, so the set of code this document can
 * ever run is closed at build time.
 *
 * `style-src 'unsafe-inline'` is required: Mermaid emits a `<style>` element
 * inside the diagram it draws. CSS derived from author data is bounded by there
 * being nowhere for it to reach — `default-src 'none'` refuses every `url()` a
 * stylesheet could name.
 *
 * `img-src data:` lets a Lottie animation carry its own embedded raster assets
 * while still refusing every remote one.
 */
const contentSecurityPolicy = (hashes: readonly string[]): string =>
  [
    "default-src 'none'",
    `script-src ${hashes.map(hash => `'${hash}'`).join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

const shellDocument = (bootstrap: Bundle, libraries: readonly Bundle[]): string => {
  const policy = contentSecurityPolicy([bootstrap.hash, ...libraries.map(library => library.hash)]);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${policy}" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>fy-render sandbox</title>
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        background: transparent;
        overflow: hidden;
      }
      #fy-render-stage {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100vw;
        height: 100vh;
      }
      #fy-render-stage > svg {
        max-width: 100%;
        max-height: 100%;
      }
    </style>
  </head>
  <body>
    <div id="fy-render-stage"></div>
    <script>${bootstrap.text}</script>
  </body>
</html>
`;
};

interface BuiltShell {
  readonly shell: string;
  readonly bundles: readonly Bundle[];
}

/**
 * PURE PER OUTPUT DIRECTORY, AND DELIBERATELY NOT CACHED.
 *
 * This function used to hold a one-slot process memo, added when two integration
 * files each called it in `beforeAll` and the pair wedged. That memo was the wrong
 * shape twice over. It was unkeyed, so gaining an output-directory argument would
 * have let a second caller silently receive the first caller's directory. And it
 * did not fix the wedge: an independent diagnosis established that the shell
 * promise coalesced and COMPLETED, while the visual file's second `Bun.build` —
 * the one traversing the real component graph — never resolved. A cache cannot
 * make an unresolved compile safe.
 *
 * So the boundary moved out of this file entirely. No `Bun.build` runs inside the
 * Bun test process any more: `build-fy-render-integration-fixture.ts` is a CLI
 * that the test loader spawns as a child, and same-process de-duplication is the
 * LOADER's job — it memoises the child-process promise, which is the thing worth
 * memoising. This function is now what it always should have been: deterministic
 * given its inputs, writing only under the directory it is handed.
 */
export const buildFyRenderShell = async (
  directory: string = publicDirectory,
): Promise<BuiltShell & { readonly artifacts: FyRenderShellArtifacts }> => {
  const artifacts = fyRenderShellArtifactsIn(directory);
  const bundleFor = async (name: string, entry: string): Promise<Bundle> => {
    const source = await build(entry);
    assertInvariants(name, source);
    return { hash: sha256(source), name, text: source };
  };

  const mermaid = await bundleFor('mermaid', 'mermaid-entry.ts');
  const lottie = await bundleFor('lottie', 'lottie-entry.ts');

  const bootstrapSource = escapeForInlineScript(await build('bootstrap.ts'));
  assertInvariants('bootstrap', bootstrapSource);
  const bootstrap: Bundle = { hash: sha256(bootstrapSource), name: 'bootstrap', text: bootstrapSource };

  const shell = shellDocument(bootstrap, [mermaid, lottie]);
  assertShellContract(shell, [bootstrap, mermaid, lottie]);

  await mkdir(directory, { recursive: true });
  await writeFile(artifacts.mermaid, mermaid.text, 'utf8');
  await writeFile(artifacts.lottie, lottie.text, 'utf8');
  await writeFile(artifacts.shell, shell, 'utf8');

  return { artifacts, bundles: [bootstrap, mermaid, lottie], shell };
};

/**
 * The generated document has to be checked by SOMETHING, and it cannot be an
 * ordinary unit test: importing this module from `tests/unit` would put a
 * `scripts/` file into the unit coverage ledger, which is disjoint from
 * `src/lib` and would fail the gate. So the contract is enforced here, in the
 * build path every deploy runs, where a violation stops the build instead of
 * turning into a fake green somewhere else.
 */
const assertShellContract = (shell: string, bundles: readonly Bundle[]): void => {
  const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/u.exec(shell)?.[1];
  if (policy === undefined) throw new Error('❌ the shell carries no Content-Security-Policy meta tag');
  const scriptSrc = /script-src ([^;]+)/u.exec(policy)?.[1];
  if (scriptSrc === undefined) throw new Error('❌ the shell policy declares no script-src');

  // The bytes that were hashed must be the bytes that ship.
  for (const bundle of bundles) {
    const digest = createHash('sha256').update(bundle.text, 'utf8').digest('base64');
    if (!scriptSrc.includes(`'sha256-${digest}'`))
      throw new Error(`❌ ${bundle.name}'s hash is not pinned in the shell's script-src`);
  }

  if (!policy.includes("default-src 'none'")) throw new Error("❌ the shell policy lost `default-src 'none'`");
  for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", "'self'", 'http:', 'https:'])
    if (scriptSrc.includes(forbidden))
      throw new Error(`❌ the shell's script-src gained ${forbidden}; only build-time hashes may appear`);

  // A subresource of any kind would be a request, and the frame may issue none.
  if (/<script[^>]+src=/iu.test(shell)) throw new Error('❌ the shell carries an external script source');
  if (/<link[^>]/iu.test(shell) || /\bhref=/iu.test(shell))
    throw new Error('❌ the shell carries a linked resource the frame would have to fetch');
};

/**
 * Proves the Lottie invariant would actually FIRE, using planted sources rather
 * than trusting a regex by reading it. A guard that has never refused anything
 * is a guard nobody has tested — and the previous spelling of this one, which
 * required the `new` keyword, would have let the bare call form straight past.
 */
const assertGuardsBite = (): void => {
  // The every-bundle invariant, planted at position zero where an unanchored
  // pattern would have missed it.
  for (const planted of [
    'import("./chunk.js")',
    'var a = import("./chunk.js");',
    'var a = import/* a comment is legal here */("./chunk.js");',
  ]) {
    let threw = false;
    try {
      assertInvariants('mermaid', planted);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`❌ the dynamic-import invariant did not fire on: ${planted}`);
  }

  /**
   * Direct, statically named spellings that reach the same capability. The first
   * six are the cases the old regexes already refused; the rest are the ones a
   * security review or the lexical audit demonstrated walked straight past
   * them, and each is here because it was MISSED, not because it looked
   * plausible.
   */
  const mustThrow = [
    // Direct, both call forms, including at position zero where a minified
    // bundle can begin with the call and an unanchored pattern had nothing to
    // match against.
    'var a = Function("return 1");',
    'var a = new Function("return 1");',
    'Function("x")',
    'eval("x")',
    'var a = eval("1");',
    'var a = ({}).constructor("x");',
    'setExpressionsPlugin(Expressions);',
    // Through a property, which is how the global is actually reachable from
    // inside a bundle that never writes the bare name.
    'globalThis.Function("return 1");',
    'globalThis.eval("1");',
    'a.b.c.Function("x");',
    'new globalThis.Function("x");',
    'var a = {}.constructor("x");',
    // Static call/apply/bind receiver indirection. The lexical tail is the
    // helper, but the capability it invokes or binds is the receiver.
    'Function.call(null, "return 1");',
    'globalThis["Function"].apply(null, ["return 1"]);',
    'eval.call(null, source);',
    'Function.bind(null, "return 1")();',
    '({}).constructor.call(null, "return 1");',
    'globalThis.Function["call"](null, "return 1");',
    'globalThis.Function["call"]?.(null, "return 1");',
    // Through a computed property, string-valued and therefore still a name.
    'globalThis["Function"]("x");',
    'globalThis["eval"]("x");',
    'globalThis[`Function`]("x");',
    'globalThis[`\\u0065val`]("x");',
    'new globalThis["Function"]("x");',
    'obj[("constructor")]("x");',
    // Through the escape spellings a lexer decodes and a character class cannot.
    'globalThis["\\u0046unction"]("x");',
    'var \\u0065val2 = 0; \\u0065val("x");',
    // Optional call and optional access — the `?.` between callee and arguments
    // is the shape the old `\\s*\\(` could never span.
    'obj.constructor?.("x");',
    'setExpressionsPlugin?.(Expressions);',
    'obj?.constructor("x");',
    'obj?.["constructor"]("x");',
    'x?.constructor?.(y);',
    // Grouped and comma-sequenced, the classic indirect-eval spellings.
    '(eval)("1");',
    '(0, eval)("1");',
    '((0, globalThis.Function))("x");',
    'new (globalThis.Function)("x");',
    // A division whose left operand ends in `}` must not be rescanned as one
    // enormous regex literal that swallows the live eval before the next `/`.
    'var ratio = {} / 2; eval("x"); var pattern = /bar/;',
    // `new` with NO argument list — a construction that contains not one
    // parenthesis, and therefore nothing for a paren-anchored detector to see.
    'var a = new Function;',
    'var a = new globalThis.Function;',
    'var a = new globalThis["Function"];',
    'var a = new (0, Function);',
    'var a = new x.constructor;',
    // A tagged template invokes its tag exactly as a call does.
    'eval`x`;',
    'obj.constructor`x`;',
    // The plugin registration in the form the old pattern's argument class
    // required, and in the two it did not.
    'setExpressionsPlugin();',
    'setExpressionsPlugin("expressions");',
  ];
  for (const planted of mustThrow) {
    let threw = false;
    try {
      assertInvariants('lottie', planted);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`❌ the Lottie invariant did not fire on planted source: ${planted}`);
  }

  /**
   * And it must not fire on ordinary code, or it would block every build.
   *
   * These are controls, not decoration. Property ACCESS is fine — it is the call
   * that builds a function, and the real bundle's one `constructor` token is an
   * access. A class body's `constructor(t){…}` is a definition. And the whole
   * point of tokenising rather than matching text is that an occurrence inside a
   * string, a comment, a regex literal or a template is not code: the previous
   * guard stopped the build on all four and called that conservatism.
   */
  const mustPass = [
    'var f = obj.Function; var g = x.eval; var h = a.constructor;',
    'class B { constructor(t) { this.t = t; } }',
    // Lifted from the shipped bundle: its single `constructor` token.
    'if(Z.o.x.constructor===Array){var w=1;}',
    'var s = "Function(\\"return 1\\")"; var s2 = \'eval("1")\';',
    '// Function("x")\nvar a = 1;',
    '/* eval("1") and new Function("x") */ var b = 2;',
    'var re = /Function\\(/; var re2 = /eval\\(x\\)/g;',
    'var re3 = /obj\\.constructor\\(/; var re4 = /new Function\\(/;',
    'var t0 = `eval("x") and new Function("y")`;',
    'var t = `Function(${x})`; var u = `a${b}c`;',
    // The dangerous names in TEMPLATE TEXT, on both sides of a substitution, so
    // the `}`-resumes-a-template decision is exercised rather than assumed.
    'var z = `x.constructor("y")${q}new Function("z")`;',
    // `new.target` is a meta-property, not a construction of anything.
    'function f(){ return new.target; } var d = new Date(); var m = new Map();',
    // Whole names only: a prefix or a suffix is a different function.
    'var a = myEval("x"); var b = FunctionLike("y"); var c = constructorOf(1);',
    'var o = { constructor: 1, eval: 2 }; var p = o.constructor;',
    // Passed as a value rather than called. Declared residual: this is NOT an
    // execution site to a name-tail analysis, and the control says so out loud.
    'f(0, eval); g(Function);',
    // Division, which the lexer must not read as a regex, and vice versa.
    'var q = a / b; var r = c / d / e;',
    'function Function(a){ return a; } function* eval2(){ yield 1; }',
    'var v = (0, notEval)("1"); var w = obj["notFunction"]("x");',
    'try { a(); } catch (eval3) { b(); }',
  ];
  for (const planted of mustPass) assertInvariants('lottie', planted);
};

if (import.meta.main) {
  assertGuardsBite();
  const { shell, bundles } = await buildFyRenderShell();
  const kib = (text: string): string => `${(text.length / 1024).toFixed(0)} KiB`;
  for (const bundle of bundles)
    console.log(`   ${bundle.name.padEnd(9)} ${kib(bundle.text).padStart(9)}  ${bundle.hash}`);
  console.log(`✅ fy-render sandbox shell written (${kib(shell)})`);
}
