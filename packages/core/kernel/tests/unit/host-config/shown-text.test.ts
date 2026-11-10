/**
 * CFG-LEAK-R: what a read of a configuration file SHOWS. `shownConfigText` is the one function both doors call
 * (`GET /v1/config/file` and `config_read`), so every rule of the mask is pinned here, on the text itself. The doors
 * themselves are `config-routes-masked.test.ts`, `agent-config-masked.test.ts` and `config-masked-host.test.ts`.
 *
 * Fake only: every value is shaped like a credential and is none.
 */
import { describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/std/yaml';
import { shownConfigText, type ShownConfigText } from '../../../host/config/shown-text.ts';
import { anyDef, fileDef, HIDDEN, OTHER_VALUE, openDef, recordsDef, SHORT_PASSWORD, VALUE } from './masked-support.ts';

/** Fake only: shaped like a provider key, never one. */
const FAKE_KEY = `sk-ant-api03-${'A'.repeat(90)}`;

type Def = Parameters<typeof shownConfigText>[0];

const read = (text: string, def: Def = fileDef): ShownConfigText => shownConfigText(def, 'servers.yaml', text, 'fy');

function shownOf(text: string, def: Def = fileDef) {
  const result = read(text, def);
  if (result.kind !== 'shown') throw new Error(`expected a shown text, got ${result.reason}`);
  return result;
}

describe('what is cut, and what stays', () => {
  test('CFG-LEAK-R glued --client-secret=v, -e API_KEY=v, Authorization: Bearer v, https://u:p@h each cut to the value; flag/key/user/host shown', () => {
    const text = [
      'args:',
      `  - --client-secret=${VALUE}`,
      '  - -e',
      `  - API_KEY=${VALUE}`,
      `  - "--header=Authorization: Bearer ${VALUE}"`,
      `url: https://alice:${VALUE}@host.example/path`,
      '',
    ].join('\n');
    const result = shownOf(text);
    expect(result.text).not.toContain(VALUE);
    // The value is cut and the spelling around it is kept: a person sees WHICH word it was.
    expect(result.text).toContain(`--client-secret=${HIDDEN}`);
    expect(result.text).toContain(`API_KEY=${HIDDEN}`);
    expect(result.text).toContain(`Authorization: ${HIDDEN}`);
    expect(result.text).toContain(`https://alice:${HIDDEN}@host.example/path`);
    expect(result.hidden).toHaveLength(4);
  });

  test('CFG-LEAK-R the value after --token in a list is cut, and the flag, the program and the other words stay', () => {
    const result = shownOf(`command: srv\nargs:\n  - --verbose\n  - --token\n  - ${VALUE}\n  - --port\n  - "8080"\n`);
    expect(result.text).toBe(
      `command: srv\nargs:\n  - --verbose\n  - --token\n  - ${HIDDEN}\n  - --port\n  - "8080"\n`,
    );
    expect(result.hidden).toEqual([{ line: 5 }]);
  });

  test('CFG-LEAK-R a string with blanks outside a list is read as a command line: "srv --token v" is cut at v', () => {
    const result = shownOf(`note: srv --verbose --token ${VALUE} --port 80\n`);
    expect(result.text).toBe(`note: srv --verbose --token ${HIDDEN} --port 80\n`);
  });

  test('CFG-LEAK-R ${secret:NAME}, $NAME and ${NAME} stay visible', () => {
    const text = [
      'args:',
      '  - --token',
      '  - ${secret:GH_TOKEN}',
      '  - --api-key=$MY_KEY',
      '  - --password=${DB_PASS}',
      'env:',
      '  DB_PASSWORD: ${secret:DB_PW}',
      '',
    ].join('\n');
    const result = shownOf(text);
    expect(result.text).toBe(text);
    expect(result.hidden).toEqual([]);
  });

  test('CFG-LEAK-R E3: the mask is the broad net — a word after a flag whose name holds TOKEN is cut even when it is a path', () => {
    // The write rule (flag-secrets.test.ts) lets `--token-file ~/.x` save; the read mask may over-hide, and says so.
    const result = shownOf('args:\n  - --token-file\n  - ~/.config/tool/token\n');
    expect(result.text).toBe(`args:\n  - --token-file\n  - ${HIDDEN}\n`);
  });

  test('CFG-LEAK-R env.DB_PASSWORD of 10 chars is cut; a secret NAME under GITHUB_TOKEN stays', () => {
    const result = shownOf(
      `env:\n  DB_PASSWORD: ${SHORT_PASSWORD}\n  GITHUB_TOKEN: MY_GH_PAT_NAME\n  LOG_LEVEL: debuglevel\n`,
    );
    expect(result.text).toBe(
      `env:\n  DB_PASSWORD: ${HIDDEN}\n  GITHUB_TOKEN: MY_GH_PAT_NAME\n  LOG_LEVEL: debuglevel\n`,
    );
    expect(result.hidden).toEqual([{ line: 2 }]);
  });

  test('CFG-LEAK-R a value in any other open map is cut by its nearest key too', () => {
    const result = shownOf(`outer:\n  inner:\n    api_token: ${SHORT_PASSWORD}\n    mode: fast\n`, openDef);
    expect(result.text).toBe(`outer:\n  inner:\n    api_token: ${HIDDEN}\n    mode: fast\n`);
  });

  test('CFG-LEAK-R a list item is judged by the key of its list: items under `tokens:` are cut, whatever they hold', () => {
    const result = shownOf(
      `tokens:\n  - ${SHORT_PASSWORD}\n  - ${OTHER_VALUE}\nplain:\n  - ${SHORT_PASSWORD}\n`,
      openDef,
    );
    expect(result.text).toBe(`tokens:\n  - ${HIDDEN}\n  - ${HIDDEN}\nplain:\n  - ${SHORT_PASSWORD}\n`);
  });

  test('CFG-LEAK-R a list that mixes strings and other values cuts the strings by the word before them', () => {
    const result = shownOf(`list:\n  - --token\n  - 7\n  - ${VALUE}\n  - [--password, ${OTHER_VALUE}]\n`, openDef);
    expect(result.text).toBe(`list:\n  - --token\n  - 7\n  - ${VALUE}\n  - [--password, ${HIDDEN}]\n`);
  });
});

describe('what the mask keeps', () => {
  test('CFG-LEAK-R comments, key order and every unhidden byte survive the mask', () => {
    const text = [
      '# first comment',
      'command: srv # trailing one',
      'args:',
      '  # above the flag',
      '  - --token # the flag',
      `  - ${VALUE} # the value`,
      '  - keep-me',
      '',
      "note: 'single quoted'   # end",
      '',
    ].join('\n');
    const result = shownOf(text);
    expect(result.text).toBe(text.replace(VALUE, HIDDEN));
  });

  test('R-0072 a file with nothing to hide reads byte-identical, however it is written', () => {
    const text = '# odd   spacing\nargs: [ --verbose,   --port ,"8080" ]\n\n\nnote:    "kept"\nenv: {A: b,   C: d}\n';
    const result = shownOf(text);
    expect(result.text).toBe(text);
    expect(result.hidden).toEqual([]);
  });

  test('CFG-LEAK-R each hidden value is reported by the line it is on in the shown text', () => {
    const result = shownOf(
      `args:\n  - --token\n  - ${VALUE}\n  - --api-key=${OTHER_VALUE}\nenv:\n  X_PASSWORD: ${SHORT_PASSWORD}\n`,
    );
    expect(result.hidden).toEqual([{ line: 3 }, { line: 4 }, { line: 6 }]);
  });
});

describe('a value that is repeated where the mask does not look', () => {
  test('CFG-LEAK-R a value an alias repeats is never shown: unmaskable → withheld', () => {
    // `note` is no secret name, so only the alias in `args` is cut; the anchor is where the value is still written.
    const result = read(`note: &n ${VALUE}\nargs:\n  - --token\n  - *n\n`);
    expect(result).toEqual({ kind: 'withheld', reason: 'unmaskable' });
  });

  test('CFG-LEAK-R a value repeated in a comment is never shown: unmaskable → withheld', () => {
    const result = read(`# was --token ${VALUE}\nargs:\n  - --token\n  - ${VALUE}\n`);
    expect(result).toEqual({ kind: 'withheld', reason: 'unmaskable' });
  });

  test('CFG-LEAK-R more distinct hidden values than can each be searched for: unmaskable → withheld', () => {
    const many = Array.from(
      { length: 101 },
      (_, index) => `  - --token\n  - Qv${String(index).padStart(3, '0')}xLmN7rTzK9\n`,
    );
    expect(read(`args:\n${many.join('')}`)).toEqual({ kind: 'withheld', reason: 'unmaskable' });
    expect(read(`args:\n${many.slice(0, 100).join('')}`).kind).toBe('shown');
  });

  test('CFG-LEAK-R a cut value too short to search for does not withhold the file', () => {
    const result = shownOf('args:\n  - https://alice:pw@host.example\n  - pw\n');
    expect(result.text).toBe('args:\n  - https://alice:‹hidden›@host.example\n  - pw\n');
  });

  test('CFG-LEAK-R a literal ‹hidden› in a value is not taken for a cut', () => {
    const result = shownOf(`note: before ‹hidden› --token ${VALUE}\n`);
    expect(result.text).toBe(`note: before ‹hidden› --token ${HIDDEN}\n`);
  });

  test('CFG-LEAK-R a top-level list that holds a value to hide cannot be re-set by key: unmaskable → withheld', () => {
    expect(read(`- --token\n- ${VALUE}\n`, anyDef)).toEqual({ kind: 'withheld', reason: 'unmaskable' });
    // …and one with nothing to hide is shown whole.
    expect(shownOf('- --verbose\n- --port\n', anyDef).text).toBe('- --verbose\n- --port\n');
  });
});

describe('when the text is not shown at all', () => {
  test('S6 R-0072 a file that holds a raw secret is withheld: raw_secret', () => {
    expect(read(`note: ${FAKE_KEY}\n`)).toEqual({ kind: 'withheld', reason: 'raw_secret' });
  });

  test('S6 R-0072 a file that does not parse and holds a raw secret in its raw text is withheld: raw_secret', () => {
    expect(read(`note: [unclosed\n# ${FAKE_KEY}\n`)).toEqual({ kind: 'withheld', reason: 'raw_secret' });
  });

  test('R-0072 a file that does not parse and holds no secret is shown as it is', () => {
    const result = shownOf('note: [unclosed\n');
    expect(result.text).toBe('note: [unclosed\n');
    expect(result.hidden).toEqual([]);
  });

  test('S6 R-0072 a def of credential records withholds a file that fails its check, whatever the reason', () => {
    expect(read('name: x\nunknown: 1\n', recordsDef)).toEqual({ kind: 'withheld', reason: 'raw_secret' });
    expect(shownOf('name: x\n', recordsDef).text).toBe('name: x\n');
  });

  test('R-0072 a text over the cap is withheld: too_large, and is not read', () => {
    expect(read(`note: ${'x'.repeat(CONFIG_FILE_MAX_BYTES + 1)}\n`)).toEqual({ kind: 'withheld', reason: 'too_large' });
  });

  test('CFG-LEAK-R a file that fails its schema is still shown, with the same mask', () => {
    const result = shownOf(`args:\n  - --token\n  - ${VALUE}\nnot_a_key: 1\n`);
    expect(result.text).toBe(`args:\n  - --token\n  - ${HIDDEN}\nnot_a_key: 1\n`);
  });
});
