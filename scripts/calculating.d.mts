/** Types of scripts/calculating.mjs (the rule for the app's calculating files). */
export function runtimeImports(source: string): string[];
export function hasCode(source: string): boolean;
export function isCalculating(source: string): boolean;
export function calculatingFiles(root?: string): string[];
export function untested(root?: string): string[];
