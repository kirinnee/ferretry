import { describe, expect, it } from 'bun:test';
import { FERRETS_PROVIDED_APP_HOOKS, FERRETS_FILE_OPEN_HOOK, isFerretsFileOpen } from '../../../../contract/index.ts';
import { createFileOpen } from '../../../../app/features/files/file-open-hook.ts';
import { useFileOpenRequest } from '../../../../app/features/files/open-request.ts';
import type { FerretsClient } from '../../../../app/lib/client.ts';
import { render, run } from '../support/react.ts';

const client: FerretsClient = { call: async () => undefined as never };

/** Shows the newest request Files would be handed for one ferret. */
function Listener({ ferretId }: { readonly ferretId: string }) {
  const request = useFileOpenRequest({ client, ferretId });
  return <p>{request === null ? 'none' : request.reference.path}</p>;
}

const shown = (renderer: ReturnType<typeof render>): string => {
  const [text] = renderer.root.findByType('p').children;
  return String(text);
};

describe('ferrets.file-open', () => {
  it('should request the path in the ferret Files panel, and answer true', () => {
    const renderer = render(<Listener ferretId="f1" />);
    let answer = false;
    run(() => {
      answer = createFileOpen(client).open('f1', 'src/a.ts');
    });
    expect(answer).toBeTrue();
    expect(shown(renderer)).toBe('src/a.ts');
  });

  it('should drop a leading ./ and never ask another ferret panel', () => {
    const renderer = render(<Listener ferretId="f2" />);
    run(() => {
      createFileOpen(client).open('f1', './x.ts');
    });
    expect(shown(renderer)).toBe('none');
  });

  it('should refuse an absolute path, a climb, a backslash, a NUL or no ferret before requesting anything', () => {
    const renderer = render(<Listener ferretId="f1" />);
    const opener = createFileOpen(client);
    const answers: boolean[] = [];
    run(() => {
      for (const path of ['/etc/passwd', '../x', 'a/../../x', 'a\\b', 'a\u0000b', ''])
        answers.push(opener.open('f1', path));
      answers.push(opener.open('', 'src/a.ts'));
    });
    expect(answers.every(answer => !answer)).toBeTrue();
    expect(shown(renderer)).toBe('none');
  });

  it('should be declared as the one hook Ferrets provides, with a narrowing that wants an open function', () => {
    const narrows = FERRETS_PROVIDED_APP_HOOKS[FERRETS_FILE_OPEN_HOOK];
    expect(narrows({ open: () => true })).toBeTrue();
    expect(narrows({})).toBeFalse();
    expect(narrows(null)).toBeFalse();
    expect(isFerretsFileOpen({ open: 'no' })).toBeFalse();
  });
});
