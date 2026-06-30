// Skills block extraction.
// Extracted from index.ts so tests can import without activating the extension.

// Extract skills block from pi's system prompt for forwarding to CodeBuddy.
export function extractSkillsBlock(systemPrompt?: string): string | undefined {
  if (!systemPrompt) return undefined;
  const startMarker = "The following skills provide specialized instructions for specific tasks.";
  const endMarker = "</available_skills>";
  const start = systemPrompt.indexOf(startMarker);
  if (start === -1) return undefined;
  const end = systemPrompt.indexOf(endMarker, start);
  if (end === -1) return undefined;
  return rewriteSkillsBlock(systemPrompt.slice(start, end + endMarker.length).trim());
}

export function rewriteSkillsBlock(skillsBlock: string): string {
  return skillsBlock.replace(
    "Use the read tool to load a skill's file",
    "Use the read tool to load a skill's file",
  );
}
