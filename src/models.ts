// Model definitions for CodeBuddy provider.

export const MODEL_IDS_IN_ORDER = ["hy3-preview-agent-ioa", "claude-sonnet-4.6", "deepseek-v4-pro-ioa", "glm-5.2-ioa"];

export function buildModels<T extends { id: string; [key: string]: any }>(models: T[]): T[] {
  return models.map((m) => ({
    ...m,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
  const lower = input.toLowerCase();
  return models.find((m) => m.id === lower || m.id.includes(lower));
}

export function codebuddyModelId(model: { id: string }): string {
  return model.id;
}
