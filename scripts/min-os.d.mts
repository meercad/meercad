/** Types of scripts/min-os.mjs (built apps checked against their oldest supported system). */
export function compareVersions(a: string, b: string): number;
export function parseMinos(text: string): string[];
export function machOFiles(dir: string): string[];
export function newerThan(bundle: string, minimum: string): { file: string; minos: string }[];
export function assertMinOs(
  bundle: string,
  minimum: string,
  system: string,
  allowed?: Record<string, string>,
): void;
