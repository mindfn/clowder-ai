/**
 * Cat Model Configuration
 * F32-b: Dynamic env key resolution — CAT_{CATID}_MODEL (uppercased, hyphens → underscores)
 *
 * 优先级: 环境变量 > catRegistry（from resolved runtime cat config） > CAT_CONFIGS 硬编码
 *
 * 环境变量 examples:
 *   CAT_OPUS_MODEL      → 布偶猫模型
 *   CAT_OPUS_45_MODEL   → 布偶猫 4.5 模型 (F32-b variant)
 *   CAT_CODEX_MODEL     → 缅因猫模型
 *   CAT_GEMINI_MODEL    → 暹罗猫模型
 *
 * 或修改 repo 根 `cat-template.json` / 运行时 `.cat-cafe/cat-catalog.json`
 */

import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';

/**
 * F32-b: Generate dynamic env key from catId.
 * e.g. "opus" → "CAT_OPUS_MODEL", "opus-45" → "CAT_OPUS_45_MODEL"
 */
function getCatModelEnvKey(catId: string): string {
  return `CAT_${catId.toUpperCase().replace(/-/g, '_')}_MODEL`;
}

/**
 * 获取猫的实际模型
 * F32-b: Dynamic env key + catRegistry as primary source
 * 优先级: 环境变量 > catRegistry（from resolved runtime cat config） > CAT_CONFIGS 硬编码
 */
export function getCatModel(catName: string): string {
  // 1. 环境变量最高优先 (dynamic key: CAT_{CATID}_MODEL)
  const envKey = getCatModelEnvKey(catName);
  const envValue = process.env[envKey]?.trim();
  if (envValue) {
    return envValue;
  }

  // 2. catRegistry (populated from the resolved runtime cat config at startup)
  const entry = catRegistry.tryGet(catName);
  if (entry) {
    return entry.config.defaultModel;
  }

  // 3. 硬编码默认值 (legacy fallback)
  const config = CAT_CONFIGS[catName];
  if (config) {
    return config.defaultModel;
  }

  throw new Error(`No model configured for cat "${catName}"`);
}

/**
 * 获取所有猫的模型配置 (用于 ConfigRegistry)
 */
export function getAllCatModels(): Record<string, string> {
  const result: Record<string, string> = {};
  const allIds = catRegistry.getAllIds().length > 0 ? catRegistry.getAllIds().map(String) : Object.keys(CAT_CONFIGS);
  for (const catName of allIds) {
    result[catName] = getCatModel(catName);
  }
  return result;
}
