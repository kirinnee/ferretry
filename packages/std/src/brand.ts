declare const brand: unique symbol;

/**
 * A nominal type: `Brand<string, 'CardId'>` is a string the type checker will not accept where another brand
 * (or a bare string) is expected. Mint one only in the parser or factory that checked it.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Asserts the brand after a check the caller already made. Use only inside a parser or a factory. */
export function brandAs<B extends string>(): <T>(value: T) => Brand<T, B> {
  return <T>(value: T) => value as Brand<T, B>;
}
