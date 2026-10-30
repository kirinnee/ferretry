/** Where `fy render` writes: the narrow slice of the console it needs. */
export interface IRenderOutput {
  success(message: string): void;
}
