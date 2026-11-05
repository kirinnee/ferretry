import type { ReactTestInstance } from 'react-test-renderer';
import { run } from './react.ts';

interface Rendered {
  readonly root: ReactTestInstance;
}

/** The radios of one `Segmented` row, by the group's accessible name. */
export const segmentedRadios = (view: Rendered, label: string): ReactTestInstance[] => {
  const group = view.root.findAll(
    node => node.type === 'div' && node.props.role === 'radiogroup' && node.props['aria-label'] === label,
  )[0];
  if (group === undefined) throw new Error(`no segmented row named ${label}`);
  return group.findAll(node => node.type === 'input');
};

/** Opens every closed (i) on a row, so the long text behind it is in the tree. */
export const openAllInfo = (view: Rendered): void => {
  const closed = view.root.findAll(
    node =>
      node.type === 'button' && node.props['data-setting-info'] !== undefined && node.props['aria-expanded'] === false,
  );
  run(() => {
    for (const info of closed) info.props.onClick();
  });
};

/** The switch of the row called `name`: the switch is named by the row's name span. */
export const switchOfRow = (view: Rendered, name: string): ReactTestInstance | undefined => {
  const labelIds = view.root
    .findAll(node => node.type === 'span' && typeof node.props.id === 'string' && node.children.includes(name))
    .map(node => node.props.id as string);
  return view.root.findAll(
    node => node.type === 'button' && node.props.role === 'switch' && labelIds.includes(node.props['aria-labelledby']),
  )[0];
};
