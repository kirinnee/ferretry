/**
 * The three Trusted Types policies: what each accepts, what each refuses, and that a browser without
 * Trusted Types gets the same strings by the same rules.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTrustedTypes,
  fragmentParsingPolicy,
  isHighlightMarkup,
  isWorkerScriptUrl,
  TRUSTED_TYPE_POLICIES,
  type TrustedTypePolicyFactoryLike,
  trustedHighlight,
  trustedTypes,
  trustedWorkerUrl,
} from '../../src/lib/trusted-types.ts';

/** A factory that wraps each made value, so a test can tell a policy's value from a plain string. */
const factory = () => {
  const created: string[] = [];
  const value: TrustedTypePolicyFactoryLike = {
    createPolicy: (name, rules) => {
      created.push(name);
      return {
        ...(rules.createHTML === undefined
          ? {}
          : { createHTML: (input: string) => ({ trusted: 'html', value: rules.createHTML?.(input) }) }),
        ...(rules.createScriptURL === undefined
          ? {}
          : { createScriptURL: (input: string) => ({ trusted: 'url', value: rules.createScriptURL?.(input) }) }),
      };
    },
  };
  return { value, created };
};

describe('the policy names', () => {
  it('are exactly the ones public/_headers allows', () => {
    const headers = readFileSync(join(import.meta.dir, '../../public/_headers'), 'utf8');
    expect(headers).toContain("require-trusted-types-for 'script'");
    expect(headers).toContain(`trusted-types ${TRUSTED_TYPE_POLICIES.join(' ')}`);
  });
});

describe('isHighlightMarkup', () => {
  it('accepts highlight.js spans and escaped text, and nothing else', () => {
    expect(isHighlightMarkup('<span class="hljs-keyword">const</span> a = 1 &lt; 2;')).toBe(true);
    expect(isHighlightMarkup('<span class="hljs-title function_">f</span><span class="language-xml"></span>')).toBe(
      true,
    );
    expect(isHighlightMarkup('plain')).toBe(true);
    for (const markup of [
      '<img src=x onerror=alert(1)>',
      '<span class="x" onclick="alert(1)">x</span>',
      '<span class="a"><script>alert(1)</script></span>',
      '<span class="a">x</span >',
      'a > b',
    ]) {
      expect(isHighlightMarkup(markup)).toBe(false);
    }
  });
});

describe('isWorkerScriptUrl', () => {
  it('accepts the speech worker the build emits, and its dev-server address', () => {
    expect(isWorkerScriptUrl('/assets/parakeet-worker-D-Ue--TH.js')).toBe(true);
    expect(isWorkerScriptUrl('/src/worker/parakeet-worker.ts?worker_file&type=module')).toBe(true);
    expect(isWorkerScriptUrl('/assets/whisper-worker-CgpPCptw.js')).toBe(true);
    expect(isWorkerScriptUrl('/src/worker/whisper-worker.ts?worker_file&type=module')).toBe(true);
    expect(isWorkerScriptUrl('/assets/sherpa-worker-BxnMm6wE.js')).toBe(true);
    expect(isWorkerScriptUrl('/src/worker/sherpa-worker.ts?worker_file&type=module')).toBe(true);
    for (const url of [
      '/assets/parakeet-worker-.js',
      '/assets/parakeet-worker-abc.js?x=1',
      'https://evil.test/assets/parakeet-worker-abc.js',
      '/app/assets/parakeet-worker-abc.js',
      '/assets/other-worker-abc.js',
      '/src/worker/parakeet-worker.ts',
    ]) {
      expect(isWorkerScriptUrl(url)).toBe(false);
    }
  });

  it('accepts the Vosk speech worker the build emits, and its dev-server address', () => {
    expect(isWorkerScriptUrl('/assets/vosk-worker-DonRcPBX.js')).toBe(true);
    expect(isWorkerScriptUrl('/src/worker/vosk-worker.ts?worker_file&type=module')).toBe(true);
    for (const url of [
      '/assets/vosk-worker-.js',
      '/assets/vosk-worker-abc.js?x=1',
      'https://evil.test/assets/vosk-worker-abc.js',
      '/assets/vosk-abc.js',
      '/src/worker/vosk-worker.ts',
    ]) {
      expect(isWorkerScriptUrl(url)).toBe(false);
    }
  });

  it('accepts only the app’s own worker, under its base path, with a machine label at most', () => {
    expect(isWorkerScriptUrl('/sw.verified.js')).toBe(true);
    expect(isWorkerScriptUrl('/app/sw.verified.js')).toBe(true);
    expect(isWorkerScriptUrl('/sw.verified.js?machine=Work%20laptop')).toBe(true);
    for (const url of [
      '/assets/sw.evil.js',
      '/sw.r1.js',
      'https://evil.test/sw.verified.js',
      '//evil.test/sw.verified.js',
      '/evil.js',
      '/sw.verified.js?machine=a&importScripts=x',
      '/sw.verified.js#x',
      'data:text/javascript,alert(1)',
    ]) {
      expect(isWorkerScriptUrl(url)).toBe(false);
    }
  });
});

describe('createTrustedTypes', () => {
  it('makes highlighter markup through fy-highlight, escaping anything that is not highlighter-shaped', () => {
    const made = factory();
    const types = createTrustedTypes(made.value);

    expect(made.created).toEqual(['fy-highlight', 'fy-worker']);
    expect(types.html('<span class="hljs-string">"a"</span>')).toEqual({
      trusted: 'html',
      value: '<span class="hljs-string">"a"</span>',
    });
    expect(types.html('<img src=x onerror=alert(1)>')).toEqual({
      trusted: 'html',
      value: '&lt;img src=x onerror=alert(1)&gt;',
    });
  });

  it('makes the worker URL through fy-worker, and the policy itself refuses any other script', () => {
    const made = factory();
    const types = createTrustedTypes(made.value);

    expect(types.scriptUrl('/sw.verified.js?machine=Home')).toEqual({
      trusted: 'url',
      value: '/sw.verified.js?machine=Home',
    } as unknown as string);
    expect(() => types.scriptUrl('https://evil.test/sw.js')).toThrow(/not the app's own/u);
  });

  it('keeps the policy’s own check even for a caller that skips the helper', () => {
    let rules: Parameters<TrustedTypePolicyFactoryLike['createPolicy']>[1] = {};
    createTrustedTypes({
      createPolicy: (name, given) => {
        if (name === 'fy-highlight') rules = given;
        return {};
      },
    });
    expect(() => rules.createHTML?.('<b>x</b>')).toThrow(/not highlighter output/u);
    expect(rules.createHTML?.('<span class="hljs-number">1</span>')).toBe('<span class="hljs-number">1</span>');
  });

  it('gives the same strings by the same rules where the browser has no Trusted Types', () => {
    const plain = createTrustedTypes(undefined);
    expect(plain.html('<span class="hljs-number">1</span>')).toBe('<span class="hljs-number">1</span>');
    expect(plain.html('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(plain.scriptUrl('/sw.verified.js')).toBe('/sw.verified.js');
    expect(() => plain.scriptUrl('/evil.js')).toThrow(TypeError);
  });

  it('falls back to the plain rules when a policy comes back without the method', () => {
    const bare = createTrustedTypes({ createPolicy: () => ({}) });
    expect(bare.html('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(bare.scriptUrl('/sw.verified.js')).toBe('/sw.verified.js');
  });
});

describe('the page’s shared policies', () => {
  it('are created once and serve both helpers', () => {
    expect(trustedTypes()).toBe(trustedTypes());
    expect(trustedHighlight('<span class="hljs-keyword">if</span>')).toBe('<span class="hljs-keyword">if</span>');
    expect(trustedWorkerUrl('/sw.verified.js')).toBe('/sw.verified.js');
  });
});

describe('fragmentParsingPolicy', () => {
  it('makes one fy-fragment policy per factory, passing markup through for the sanitizer to judge', () => {
    // Arrange
    const created: string[] = [];
    let rules: { createHTML?: (input: string) => string; createScriptURL?: (input: string) => string } = {};
    const fake: TrustedTypePolicyFactoryLike = {
      createPolicy: (name, given) => {
        created.push(name);
        rules = given;
        return given;
      },
    };

    // Act
    const first = fragmentParsingPolicy(fake);
    const second = fragmentParsingPolicy(fake);

    // Assert — the policy does not judge markup (DOMPurify does) and never makes a script URL.
    expect(created).toEqual(['fy-fragment']);
    expect(second).toBe(first);
    expect(rules.createHTML?.('<p onclick="x">a</p>')).toBe('<p onclick="x">a</p>');
    expect(() => rules.createScriptURL?.('/x.js')).toThrow(/script URL inside an html fragment/u);
  });

  it('is absent where the browser has no Trusted Types', () => {
    expect(fragmentParsingPolicy(undefined)).toBeNull();
  });
});
