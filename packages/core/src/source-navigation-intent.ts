/** A follow must retain the association captured before its build began. */
export function followNavigationIsCurrent<Token extends string | number>(input: {
  readonly captured: Token | undefined;
  readonly current: Token | undefined;
  readonly explicitPending: boolean;
}): boolean {
  return input.captured !== undefined && input.captured === input.current && !input.explicitPending;
}
