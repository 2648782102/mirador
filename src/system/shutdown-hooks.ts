export type ShutdownHook = () => void | Promise<void>;

/**
 * Runs the hooks one after another. A hook that fails, by throwing or by
 * rejecting, is reported and the next one still runs, so one broken hook
 * cannot skip the cleanup after it.
 */
export async function runShutdownHooks(
  hooks: readonly ShutdownHook[],
  report: (error: unknown) => void = (error) => console.error('shutdown hook failed:', error),
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      report(error);
    }
  }
}
