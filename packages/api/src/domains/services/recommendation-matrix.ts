import { SERVICE_MATRIX } from './recommendation-matrix-data.js';
import type { EnvironmentProfile, MatchCriteria, MatrixEntry, ServiceRecommendation } from './recommendation-types.js';

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function matchesCriteria(criteria: MatchCriteria, profile: EnvironmentProfile): boolean {
  if (criteria.os && !asArray(criteria.os).includes(profile.os)) return false;
  if (criteria.arch && !asArray(criteria.arch).includes(profile.arch)) return false;
  if (criteria.gpu && !asArray(criteria.gpu).includes(profile.gpu)) return false;
  if (criteria.pythonArch && !asArray(criteria.pythonArch).includes(profile.pythonArch)) return false;
  return true;
}

export function findMatrixEntry(serviceId: string, profile: EnvironmentProfile): MatrixEntry | null {
  const entries = SERVICE_MATRIX[serviceId];
  if (!entries) return null;
  return entries.find((entry) => matchesCriteria(entry.match, profile)) ?? null;
}

export function buildRecommendation(serviceId: string, profile: EnvironmentProfile): ServiceRecommendation {
  const entry = findMatrixEntry(serviceId, profile);
  if (!entry) {
    return {
      serviceId,
      profile,
      models: [],
      notes: [],
      unsupported: {
        reason: `服务 ${serviceId} 没有针对当前环境（${profile.os}/${profile.arch}/gpu=${profile.gpu}）的推荐配置`,
        userAction: '请联系开发者补充矩阵条目，或在 GitHub 提 issue',
        retryHint: '矩阵更新后无需操作，重新打开安装弹窗即可',
      },
    };
  }
  return {
    serviceId,
    profile,
    models: entry.models ?? [],
    unsupported: entry.unsupported,
    notes: entry.notes ?? [],
  };
}

export function getMatrixServiceIds(): string[] {
  return Object.keys(SERVICE_MATRIX);
}

export { SERVICE_MATRIX };
