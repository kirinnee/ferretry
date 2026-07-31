import { describe, expect, it } from 'bun:test';
import {
  ActionGroup,
  Badge,
  Button,
  Card,
  Label,
  PanelBody,
  PanelHeader,
  Textarea,
} from '../../src/shell/primitives.tsx';
import { render } from '../support/react.ts';

describe('Button', () => {
  it('renders the resting outline variant without a data-variant attribute', () => {
    const props = render(<Button>Go</Button>).root.findByType('button').props;

    expect(props.className).toBe('kt-btn');
    expect(props['data-variant']).toBeUndefined();
  });

  it('carries role and state on data-variant for every non-default variant', () => {
    for (const variant of ['primary', 'ghost', 'danger'] as const) {
      const props = render(<Button variant={variant}>Go</Button>).root.findByType('button').props;
      expect(props['data-variant']).toBe(variant);
    }
  });

  it('adds the small silhouette modifier only for size sm', () => {
    expect(render(<Button size="sm">Go</Button>).root.findByType('button').props.className).toBe('kt-btn kt-btn--sm');
    expect(render(<Button size="md">Go</Button>).root.findByType('button').props.className).toBe('kt-btn');
  });

  it('appends caller classes and forwards native button props', () => {
    const props = render(
      <Button className="w-full" type="submit" disabled>
        Go
      </Button>,
    ).root.findByType('button').props;

    expect(props.className).toBe('kt-btn w-full');
    expect(props.type).toBe('submit');
    expect(props.disabled).toBe(true);
  });
});

describe('Badge', () => {
  it('defaults to the pending tone', () => {
    const props = render(<Badge>idle</Badge>).root.findByType('span').props;

    expect(props['data-tone']).toBe('pend');
    expect(props.className).toBe('kt-badge');
  });

  it('passes the requested tone through as state, not colour', () => {
    for (const tone of ['ok', 'warn', 'err', 'accent'] as const) {
      const props = render(<Badge tone={tone}>x</Badge>).root.findByType('span').props;
      expect(props['data-tone']).toBe(tone);
      expect(props.className).toBe('kt-badge');
    }
  });
});

describe('panel primitives', () => {
  it('renders an unclipped panel so descendant popovers and focus rings survive', () => {
    expect(render(<Card />).root.findByType('div').props.className).toBe('kt-panel');
    expect(render(<Card className="mt-2" />).root.findByType('div').props.className).toBe('kt-panel mt-2');
  });

  it('renders the themed header and body slots', () => {
    expect(render(<PanelHeader />).root.findByType('div').props.className).toBe('kt-panel__header');
    expect(render(<PanelBody />).root.findByType('div').props.className).toBe('kt-panel__body');
  });

  it('renders the wrapping action group used by panel headers', () => {
    expect(render(<ActionGroup className="ml-auto" />).root.findByType('div').props.className).toBe(
      'flex flex-wrap items-center gap-sm ml-auto',
    );
  });
});

describe('Textarea', () => {
  it('keeps the tokenised input class and never disables the focus outline', () => {
    const props = render(<Textarea rows={3} />).root.findByType('textarea').props;

    expect(props.className).toBe('kt-input resize-y');
    expect(props.className).not.toContain('focus:outline-none');
    expect(props.rows).toBe(3);
  });
});

describe('Label', () => {
  it('renders the shared quiet label', () => {
    expect(render(<Label>Status</Label>).root.findByType('span').props.className).toBe('kt-label');
  });
});
