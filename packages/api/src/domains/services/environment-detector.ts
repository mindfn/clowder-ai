import { execSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import type { EnvArch, EnvGpu, EnvironmentProfile, EnvOs, PythonArch } from './recommendation-types.js';

const CACHE_TTL_MS = 30_000;
let cached: { profile: EnvironmentProfile; expiresAt: number } | null = null;

function resolveOs(): EnvOs {
  const p = process.platform;
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  throw new Error(`Unsupported OS: ${p}`);
}

function resolveArch(): EnvArch {
  if (process.arch === 'arm64') return 'arm64';
  return 'x64';
}

function runQuiet(command: string, args: string[] = [], timeout = 3000): string | null {
  try {
    const cmd = args.length ? `${command} ${args.join(' ')}` : command;
    return execSync(cmd, { encoding: 'utf-8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function detectGpu(): { gpu: EnvGpu; gpuDetail?: string } {
  const os = resolveOs();
  if (os === 'darwin') {
    if (process.arch === 'arm64') {
      return { gpu: 'apple', gpuDetail: 'Apple Silicon GPU (Metal)' };
    }
    return { gpu: 'none', gpuDetail: 'Intel Mac (no MLX support)' };
  }

  const nv = runQuiet('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
  if (nv) {
    const first = nv.split('\n')[0]?.trim();
    return { gpu: 'cuda', gpuDetail: first || 'NVIDIA GPU (CUDA)' };
  }

  if (os === 'linux') {
    const rocm = runQuiet('rocminfo');
    if (rocm && rocm.includes('Agent')) {
      return { gpu: 'rocm', gpuDetail: 'AMD GPU (ROCm)' };
    }
  }

  return { gpu: 'none' };
}

interface PythonProbe {
  command: string;
  args: string[];
  machine: string | null;
  version: string | null;
}

function probePython(command: string, args: string[]): PythonProbe {
  const versionOutput = runQuiet(
    [command, ...args, '-c', '"import sys,platform;print(platform.machine());print(sys.version.split()[0])"'].join(' '),
  );
  if (!versionOutput) return { command, args, machine: null, version: null };
  const lines = versionOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    command,
    args,
    machine: lines[0] ?? null,
    version: lines[1] ?? null,
  };
}

function listCandidatePythons(os: EnvOs): Array<{ command: string; args: string[] }> {
  if (os === 'win32') {
    return [
      { command: 'py', args: ['-3.13'] },
      { command: 'py', args: ['-3.12'] },
      { command: 'py', args: ['-3.11'] },
      { command: 'py', args: ['-3.10'] },
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
      { command: 'python3', args: [] },
      { command: 'py', args: ['-3-32'] },
      { command: 'py', args: ['-3.13-32'] },
      { command: 'py', args: ['-3.12-32'] },
      { command: 'py', args: ['-3.11-32'] },
      { command: 'py', args: ['-3.10-32'] },
    ];
  }
  return [
    { command: 'python3.13', args: [] },
    { command: 'python3.12', args: [] },
    { command: 'python3.11', args: [] },
    { command: 'python3.10', args: [] },
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
  ];
}

function isNativeMachine(machine: string, arch: EnvArch): boolean {
  const m = machine.toLowerCase();
  if (arch === 'arm64') return m === 'arm64' || m === 'aarch64';
  return m === 'x86_64' || m === 'amd64';
}

function detectPython(os: EnvOs, arch: EnvArch): { pythonArch: PythonArch; pythonVersion?: string } {
  const candidates = listCandidatePythons(os);
  const probes: PythonProbe[] = [];
  for (const cand of candidates) {
    const probe = probePython(cand.command, cand.args);
    if (probe.machine) probes.push(probe);
  }

  if (probes.length === 0) {
    return { pythonArch: 'missing' };
  }

  const native = probes.find((p) => p.machine && isNativeMachine(p.machine, arch));
  if (native) {
    return { pythonArch: 'native', pythonVersion: native.version ?? undefined };
  }

  const emulated = probes.find((p) => p.machine && !isNativeMachine(p.machine, arch));
  if (emulated) {
    return { pythonArch: 'x86-emulated', pythonVersion: emulated.version ?? undefined };
  }

  return { pythonArch: 'native', pythonVersion: probes[0]?.version ?? undefined };
}

function detectRamGb(): number {
  return Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10;
}

function detectDiskFreeGb(): number {
  const probePath = existsSync(homedir()) ? homedir() : '/';
  try {
    const stat = statfsSync(probePath);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Math.round((free / 1024 / 1024 / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

export function detectEnvironmentSync(): EnvironmentProfile {
  const os = resolveOs();
  const arch = resolveArch();
  const { gpu, gpuDetail } = detectGpu();
  const { pythonArch, pythonVersion } = detectPython(os, arch);
  return {
    os,
    arch,
    gpu,
    gpuDetail,
    pythonArch,
    pythonVersion,
    ramGb: detectRamGb(),
    diskFreeGb: detectDiskFreeGb(),
    detectedAt: Date.now(),
  };
}

export function getEnvironmentProfile(forceRefresh = false): EnvironmentProfile {
  const now = Date.now();
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.profile;
  }
  const profile = detectEnvironmentSync();
  cached = { profile, expiresAt: now + CACHE_TTL_MS };
  return profile;
}

export function clearEnvironmentCache(): void {
  cached = null;
}
