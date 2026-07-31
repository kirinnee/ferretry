/**
 * Attachment identity comparison, shared by anything that has to decide whether
 * two records describe the same message.
 *
 * Set equality, not sequence equality: the composer's upload order is an
 * accident of which file finished first, so two sends carrying the same images
 * in a different order are the same send.
 */
export const sameAttachmentIds = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
};
