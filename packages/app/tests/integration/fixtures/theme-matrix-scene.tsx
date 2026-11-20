/**
 * THE FIXED SPECIMEN PAGE the theme matrix measures (`theme-matrix.visual.test.ts`): the real shared primitives over fake
 * data, one of each thing a style has to draw: body and muted text, headings, a link, buttons in every variant, an input,
 * a card, status badges, a row of choice cards and an open menu. It owns NO style or palette: the test sets the three root
 * attributes (`data-style`, `data-palette`, `data-mode`) and reads what the page then draws, so a style or palette added
 * to the catalogue is measured without touching this file.
 *
 * Every element the test measures says so: `data-spec="text|edge|focus"`. A `text` element is read against the colour it
 * sits on, an `edge` is a control's own border against what is behind it, a `focus` element is reached by the real keyboard (Tab, then the arrow keys in the choice row and the menu) and its ring read; the choice cards and the menu rows are measured too, by their own classes.
 *
 * r11 T14 adds the elements the style probes read (`data-probe="..."`, never `data-spec`, so the r10 checks are unchanged): a
 * two-line textarea, a markdown block (h1, link, quote, list, code block, table), the shared Spinner, a settings-nav item
 * that is the current one, and a scroll box that clips (with a button, a field and a link inside it, tight against its edge).
 *
 *   ?style=<id>&palette=<id>&mode=<light|dark>      (the test re-sets these in place for every combination)
 */
import { Check } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { ChoiceCards } from '../../../src/compose/choice-cards.tsx';
import { Spinner } from '../../../src/ui/spinner.tsx';
import { Badge, Button, Card, PanelBody, PanelHeader } from '../../../src/ui/primitives.tsx';
import { ContextMenu } from '../../../src/ui/context-menu.tsx';
import { FyRenderBlock } from '../../../../plugins/conversation/app/render/fy-render-block.tsx';
import {
  type FyRenderWorkspaceReader,
  isFyRenderEmbedBlock,
  parseFyRender,
} from '../../../../plugins/conversation/app/render/fy-render.ts';

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
root.setAttribute('data-style', params.get('style') ?? 'studio');
root.setAttribute('data-palette', params.get('palette') ?? 'studio');
root.setAttribute('data-mode', params.get('mode') === 'dark' ? 'dark' : 'light');

const noop = () => undefined;

/**
 * A representative hypermedia block: the REAL `FyRenderBlock` over a parsed `fy-render` fence (an `svg` picture, which needs no
 * sandbox library and no network), so the style probe measures what the renderer actually draws and not what a token declares
 * (r11 T14, review of PR 2226). The renderer reads its slots (`--hm-*`, r11 T4) through its own stylesheet.
 */
const hypermedia = parseFyRender(
  [
    'type: svg',
    'alt: A two-node diagram',
    '---',
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64" viewBox="0 0 160 64">',
    '<rect x="4" y="12" width="56" height="40" rx="8" fill="#888" stroke="#444" stroke-width="2"/>',
    '<rect x="100" y="12" width="56" height="40" rx="8" fill="#888" stroke="#444" stroke-width="2"/>',
    '<path d="M60 32 H100" stroke="#444" stroke-width="2" fill="none"/>',
    '</svg>',
  ].join('\n'),
);
if (!hypermedia.ok) throw new Error(`the hypermedia specimen did not parse: ${hypermedia.reason}`);
if (isFyRenderEmbedBlock(hypermedia.block)) throw new Error('the hypermedia specimen is an embed block');
const hypermediaBlock = hypermedia.block;
const readNothing: FyRenderWorkspaceReader = async () => ({ ok: false, reason: 'missing' });

const OPTIONS = [
  { id: 'left', title: 'Left', line: 'The menu beside your work' },
  { id: 'right', title: 'Right', line: 'The menu on the other edge' },
] as const;

createRoot(document.getElementById('root') as HTMLElement).render(
  <main className="bg-bg text-fg" data-specimen="" style={{ minHeight: '100vh', padding: 16 }}>
    <h1 data-spec="text" style={{ fontFamily: 'var(--font-display)' }}>
      Specimen heading
    </h1>
    <p data-spec="text">
      Body text sits on the page: a sentence long enough to wrap on a phone, so the measure is real.
    </p>
    <p className="text-muted" data-spec="text">
      Muted text is the quiet line under a title.
    </p>
    <p>
      <code className="mono" data-spec="text">
        mono sample 0123
      </code>
    </p>
    <p>
      <a href="#specimen" data-spec="text focus">
        A link in the running text
      </a>
    </p>
    <div className="flex flex-wrap items-center gap-sm" style={{ margin: '12px 0' }}>
      <Button variant="primary" data-spec="text focus">
        Primary
      </Button>
      <Button data-spec="text edge focus">Outline</Button>
      <Button variant="ghost" data-spec="text focus">
        Ghost
      </Button>
      <Button variant="danger" data-spec="text focus">
        Danger
      </Button>
    </div>
    <input
      aria-label="Name"
      className="kt-input"
      data-spec="text edge focus"
      defaultValue="Ferret name"
      style={{ maxWidth: '100%' }}
    />
    <Card data-spec="panel-edge" style={{ margin: '12px 0' }}>
      <PanelHeader>
        <span data-spec="text">Card header</span>
      </PanelHeader>
      <PanelBody>
        <p data-spec="text">Card body on the raised surface.</p>
        <p className="text-muted" data-spec="text">
          Muted text on the raised surface.
        </p>
        <div className="flex flex-wrap items-center gap-sm">
          <Badge tone="ok" data-spec="text">
            ok
          </Badge>
          <Badge tone="warn" data-spec="text">
            warn
          </Badge>
          <Badge tone="err" data-spec="text">
            err
          </Badge>
          <Badge tone="accent" data-spec="text">
            accent
          </Badge>
        </div>
      </PanelBody>
    </Card>
    <textarea
      aria-label="Notes"
      className="kt-input"
      data-probe="textarea"
      defaultValue={'Two lines of text\nin a two-row field'}
      rows={2}
      style={{ maxWidth: '100%', width: 260 }}
    />
    <div className="md" data-probe="md" style={{ margin: '12px 0' }}>
      <h1>Markdown heading</h1>
      <p>
        A paragraph with <a href="#md">the markdown anchor</a> and <code>inline code</code>.
      </p>
      <ul>
        <li>First item</li>
        <li>Second item</li>
      </ul>
      <blockquote>
        <p>A quoted line.</p>
      </blockquote>
      <pre>
        <code>const answer = 42;</code>
      </pre>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>one</td>
            <td>ok</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div className="md" data-probe="hypermedia" style={{ margin: '12px 0', maxWidth: 240 }}>
      <FyRenderBlock block={hypermediaBlock} readWorkspaceMedia={readNothing} />
    </div>
    <p data-probe="spinner" style={{ margin: '12px 0' }}>
      <Spinner size={24} />
    </p>
    <nav className="fy-settings-nav" data-probe="nav" style={{ margin: '12px 0', maxWidth: 220 }}>
      <a aria-current="page" className="fy-tab fy-tab--active" href="#current">
        Current page
      </a>
      <a className="fy-tab" href="#other">
        Other page
      </a>
    </nav>
    <div data-probe="clip" style={{ overflow: 'auto', padding: 0, width: 'fit-content', maxWidth: '100%' }}>
      <Button data-spec="focus">Clipped button</Button>
      <input
        aria-label="Clipped name"
        className="kt-input"
        data-spec="focus"
        defaultValue="Clipped"
        style={{ width: 120 }}
      />
      <a data-spec="focus" href="#clipped" style={{ display: 'inline-block' }}>
        Clipped link
      </a>
    </div>
    <ChoiceCards label="Menu side" onChange={noop} options={OPTIONS} value="left" />
    <p style={{ marginTop: 12 }}>
      <Check aria-hidden size={16} /> <span data-spec="text">Done</span>
    </p>
    <section className="fy-page" style={{ padding: 0 }}>
      <h1 data-spec="text">Shell page heading</h1>
    </section>
    {/* Fixed below the content (the matrix opens the page 2400px tall: the r11 T14 probes made the content longer on a phone), so on a phone the menu never covers the text. */}
    <ContextMenu
      anchor={{ x: 16, y: 1_900 }}
      ariaLabel="Ferret actions"
      items={[
        { key: 'resume', label: 'Resume', onSelect: noop },
        { key: 'rename', label: 'Rename…', detail: 'F2', onSelect: noop },
        { key: 'stop', label: 'Stop ferret', danger: true, separatorBefore: true, onSelect: noop },
      ]}
      onClose={noop}
      open
    />
  </main>,
);
