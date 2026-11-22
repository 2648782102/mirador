// scripts/bootstrap.sh pins the prebuilt release it installs: one version and one sha256 per platform, each on a
// line of its own at the top of main. A promotion PR to main changes these lines and nothing else. Tests read
// them, and run copies of the script with other values in them.

/** The pin names, in their order in the script. */
export const PIN_NAMES = ['MIRADOR_VERSION', 'MIRADOR_SHA256_LINUX_X64', 'MIRADOR_SHA256_LINUX_ARM64'] as const;

export type PinName = (typeof PIN_NAMES)[number];
export type Pins = Partial<Record<PinName, string>>;

const pinLine = (name: string) => new RegExp(`^  ${name}="([^"\\n]*)"$`, 'gm');

/** The script's pins; throws unless each one is on exactly one line. */
export function readPins(script: string): Record<PinName, string> {
  const pins = {} as Record<PinName, string>;
  for (const name of PIN_NAMES) {
    const found = [...script.matchAll(pinLine(name))];
    if (found.length !== 1) throw new Error(`bootstrap.sh: expected one line \`  ${name}="…"\`, found ${found.length}`);
    pins[name] = found[0][1];
  }
  return pins;
}

/** `script` with every pin set to the value in `pins`, or emptied when `pins` has none for it. */
export function withPins(script: string, pins: Pins = {}): string {
  readPins(script);
  let text = script;
  for (const name of PIN_NAMES) text = text.replace(pinLine(name), () => `  ${name}="${pins[name] ?? ''}"`);
  return text;
}
