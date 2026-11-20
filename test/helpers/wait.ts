/**
 * Polls `check` until it gives a value other than undefined, and resolves with it. The same shape as the
 * bridge tests' waitFor: a check that throws counts as "not yet". After `ms` it throws an error naming
 * `what`, so a failed wait says which condition never held instead of failing a later assertion.
 * The limit is a bound only: a passing run returns as soon as the condition holds.
 */
export async function waitFor<T>(check: () => T | undefined | Promise<T | undefined>, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await Promise.resolve().then(check).catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
