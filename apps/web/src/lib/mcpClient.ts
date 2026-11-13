/** The connected program's name as people know it ("claude-code" → "Claude Code"). */
export function clientLabel(name: string | undefined): string {
  if (!name?.trim()) return "Assistant";

  const known: Record<string, string> = {
    "claude-ai": "Claude",
    claude: "Claude",
    "claude-code": "Claude Code",
    "claude-desktop": "Claude",
    "cursor-vscode": "Cursor",
    cursor: "Cursor",
    windsurf: "Windsurf",
    "visual-studio-code": "VS Code",
    vscode: "VS Code",
  };
  const key = name.trim().toLowerCase();
  if (known[key]) return known[key];

  // A machine name (lowercase with dashes) gets spaces and capitals; a proper title stays as it is.
  return /^[a-z0-9]+([-_][a-z0-9]+)*$/.test(name.trim())
    ? name
        .trim()
        .split(/[-_]/)
        .map((w) => w[0]!.toUpperCase() + w.slice(1))
        .join(" ")
    : name.trim();
}
