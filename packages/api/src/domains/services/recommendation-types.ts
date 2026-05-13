export type EnvOs = 'darwin' | 'win32' | 'linux';
export type EnvArch = 'arm64' | 'x64';
export type EnvGpu = 'apple' | 'cuda' | 'rocm' | 'none';
export type PythonArch = 'native' | 'x86-emulated';

export interface EnvironmentProfile {
  os: EnvOs;
  arch: EnvArch;
  gpu: EnvGpu;
  gpuDetail?: string;
  pythonArch: PythonArch;
  pythonVersion?: string;
  ramGb: number;
  diskFreeGb: number;
  detectedAt: number;
}

export interface ResourceRequirement {
  ramGb: number;
  diskGb: number;
  gpu?: 'required' | 'recommended' | 'optional';
}

export interface ModelOption {
  name: string;
  size: string;
  description: string;
  requirements: ResourceRequirement;
  performance?: string;
}

export interface UnsupportedReason {
  reason: string;
  userAction: string;
  retryHint: string;
}

export interface MatchCriteria {
  os?: EnvOs | EnvOs[];
  arch?: EnvArch | EnvArch[];
  gpu?: EnvGpu | EnvGpu[];
  pythonArch?: PythonArch | PythonArch[];
}

export interface MatrixEntry {
  match: MatchCriteria;
  models?: ModelOption[];
  unsupported?: UnsupportedReason;
  notes?: string[];
}

export type ServiceMatrix = Record<string, MatrixEntry[]>;

export interface ServiceRecommendation {
  serviceId: string;
  profile: EnvironmentProfile;
  models: ModelOption[];
  unsupported?: UnsupportedReason;
  notes: string[];
}
