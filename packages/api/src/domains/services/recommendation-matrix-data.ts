import type { ModelOption, ServiceMatrix } from './recommendation-types.js';

const WHISPER_MLX_TURBO: ModelOption = {
  name: 'mlx-community/whisper-large-v3-turbo',
  size: '~1.5GB',
  description: '速度快、质量高（MLX 加速）',
  requirements: { ramGb: 4, diskGb: 2 },
  performance: '实时 10x+',
};

const WHISPER_FW_TURBO: ModelOption = {
  name: 'large-v3-turbo',
  size: '~1.5GB',
  description: 'faster-whisper turbo（CTranslate2）',
  requirements: { ramGb: 4, diskGb: 2 },
  performance: 'CPU 实时 2-3x，GPU 10x+',
};

const WHISPER_FW_BASE: ModelOption = {
  name: 'base',
  size: '~150MB',
  description: '轻量版，低配机器可用',
  requirements: { ramGb: 2, diskGb: 0.5 },
  performance: 'CPU 实时 1-2x',
};

const TTS_KOKORO: ModelOption = {
  name: 'mlx-community/Kokoro-82M-bf16',
  size: '~160MB',
  description: '本地轻量高质量语音合成（MLX）',
  requirements: { ramGb: 2, diskGb: 0.5 },
  performance: '实时 5x+',
};

const TTS_EDGE: ModelOption = {
  name: 'edge-tts',
  size: '~20MB',
  description: '微软云端语音，高质量、需联网',
  requirements: { ramGb: 1, diskGb: 0.1 },
  performance: '取决于网络',
};

const TTS_SAPI: ModelOption = {
  name: 'sapi',
  size: '~5MB',
  description: 'Windows 内置语音，离线可用',
  requirements: { ramGb: 1, diskGb: 0.1 },
  performance: '实时 1x',
};

const EMBED_QWEN3_MLX: ModelOption = {
  name: 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ',
  size: '~400MB',
  description: 'Qwen3 中文向量，新一代质量（MLX）',
  requirements: { ramGb: 2, diskGb: 1 },
  performance: '实时',
};

const EMBED_BGE_BASE: ModelOption = {
  name: 'BAAI/bge-base-zh-v1.5',
  size: '~250MB',
  description: 'BGE 中文向量，ONNX 优化（CPU/GPU 通用）',
  requirements: { ramGb: 2, diskGb: 0.5 },
  performance: 'CPU 实时',
};

const EMBED_BGE_LARGE: ModelOption = {
  name: 'BAAI/bge-large-zh-v1.5',
  size: '~600MB',
  description: 'BGE 中文向量，更高维度（推荐 GPU）',
  requirements: { ramGb: 4, diskGb: 1.5, gpu: 'recommended' },
  performance: 'CPU 偏慢，GPU 实时',
};

const LLM_QWEN35_MLX: ModelOption = {
  name: 'mlx-community/Qwen3.5-35B-A3B-4bit',
  size: '~20GB',
  description: 'Qwen3.5 35B MoE，高质量纠错（MLX）',
  requirements: { ramGb: 48, diskGb: 22 },
  performance: '生成 ~30 tok/s',
};

const LLM_QWEN25_14B_MLX: ModelOption = {
  name: 'mlx-community/Qwen2.5-14B-Instruct-4bit',
  size: '~8GB',
  description: '中等质量，32GB+ 内存推荐',
  requirements: { ramGb: 24, diskGb: 9 },
};

const LLM_QWEN25_7B_MLX: ModelOption = {
  name: 'mlx-community/Qwen2.5-7B-Instruct-4bit',
  size: '~4GB',
  description: '轻量版，16GB 内存可用',
  requirements: { ramGb: 12, diskGb: 5 },
};

const LLM_QWEN25_3B_HF: ModelOption = {
  name: 'Qwen/Qwen2.5-3B-Instruct',
  size: '~6GB',
  description: 'transformers 后端，CPU/GPU 都能跑',
  requirements: { ramGb: 8, diskGb: 7 },
  performance: 'CPU 偏慢，GPU 流畅',
};

const LLM_QWEN25_7B_HF: ModelOption = {
  name: 'Qwen/Qwen2.5-7B-Instruct',
  size: '~14GB',
  description: 'transformers 后端，GPU 推荐',
  requirements: { ramGb: 16, diskGb: 15, gpu: 'recommended' },
};

export const SERVICE_MATRIX: ServiceMatrix = {
  'whisper-stt': [
    {
      match: { os: 'darwin', arch: 'arm64' },
      recommended: WHISPER_MLX_TURBO,
      alternatives: [
        {
          name: 'mlx-community/whisper-large-v3-mlx',
          size: '~3GB',
          description: '最高质量，速度较慢',
          requirements: { ramGb: 6, diskGb: 3.5 },
        },
        {
          name: 'mlx-community/whisper-small-mlx',
          size: '~500MB',
          description: '轻量版，低配机器可用',
          requirements: { ramGb: 2, diskGb: 1 },
        },
      ],
    },
    {
      match: { os: 'darwin', arch: 'x64' },
      recommended: WHISPER_FW_TURBO,
      alternatives: [
        {
          name: 'large-v3',
          size: '~3GB',
          description: '最高质量',
          requirements: { ramGb: 6, diskGb: 3.5 },
        },
        WHISPER_FW_BASE,
      ],
      caveats: ['Intel Mac 不支持 MLX，使用 faster-whisper 后端'],
    },
    {
      match: { os: ['win32', 'linux'], gpu: ['cuda', 'rocm'] },
      recommended: WHISPER_FW_TURBO,
      alternatives: [
        {
          name: 'large-v3',
          size: '~3GB',
          description: '最高质量',
          requirements: { ramGb: 6, diskGb: 3.5, gpu: 'recommended' },
        },
        WHISPER_FW_BASE,
      ],
      caveats: ['GPU 加速需 CUDA 12+ 或 ROCm 5.7+'],
    },
    {
      match: { os: ['win32', 'linux'], gpu: 'none' },
      recommended: WHISPER_FW_BASE,
      alternatives: [{ ...WHISPER_FW_TURBO, performance: 'CPU 实时 2x，可能偏慢' }],
      caveats: ['纯 CPU 上 large 模型偏慢，推荐 base'],
    },
  ],

  'mlx-tts': [
    {
      match: { os: 'darwin', arch: 'arm64' },
      recommended: TTS_KOKORO,
      alternatives: [{ ...TTS_EDGE, description: '微软云端，备选（需联网）' }],
    },
    {
      match: { os: 'darwin', arch: 'x64' },
      recommended: TTS_EDGE,
      alternatives: [],
      caveats: ['Intel Mac 不支持 MLX-Audio，使用 edge-tts'],
    },
    {
      match: { os: 'win32' },
      recommended: TTS_EDGE,
      alternatives: [TTS_SAPI],
      caveats: ['edge-tts 需要联网；sapi 离线但音色较老'],
    },
    {
      match: { os: 'linux' },
      recommended: TTS_EDGE,
      alternatives: [],
      caveats: ['Linux 暂无内置离线方案，仅支持 edge-tts'],
    },
  ],

  'embedding-model': [
    {
      match: { os: 'darwin', arch: 'arm64' },
      recommended: EMBED_QWEN3_MLX,
      alternatives: [],
    },
    {
      match: { os: 'darwin', arch: 'x64' },
      recommended: EMBED_BGE_BASE,
      alternatives: [{ ...EMBED_BGE_LARGE, description: '更高质量，Intel Mac CPU 偏慢' }],
      caveats: ['Intel Mac 不支持 MLX，使用 ONNX 后端'],
    },
    {
      match: { os: ['win32', 'linux'], gpu: ['cuda', 'rocm'] },
      recommended: EMBED_BGE_LARGE,
      alternatives: [EMBED_BGE_BASE],
    },
    {
      match: { os: ['win32', 'linux'] },
      recommended: EMBED_BGE_BASE,
      alternatives: [{ ...EMBED_BGE_LARGE, description: '更高质量，但 CPU 偏慢' }],
    },
  ],

  'llm-postprocess': [
    {
      match: { os: 'darwin', arch: 'arm64' },
      recommended: LLM_QWEN35_MLX,
      alternatives: [LLM_QWEN25_14B_MLX, LLM_QWEN25_7B_MLX],
      caveats: ['Qwen3.5-35B 需要 48GB+ 统一内存'],
    },
    {
      match: { os: 'darwin', arch: 'x64' },
      recommended: LLM_QWEN25_3B_HF,
      alternatives: [LLM_QWEN25_7B_HF],
      caveats: ['Intel Mac 不支持 MLX，使用 transformers 后端'],
    },
    {
      match: { os: 'win32', arch: 'arm64', pythonArch: 'native' },
      unsupported: {
        reason: 'transformers + safetensors 在 Windows ARM64 没有预编译 wheel，原生 ARM Python 装不上',
        userAction: '请安装 x86 Python 3.10+（python.org 上下载 64-bit Windows 安装包，Microsoft Store 版也可）',
        retryHint: '安装好 x86 Python 后，关闭此弹窗再次点击「安装」，会自动按 x86 模式重新匹配',
      },
    },
    {
      match: { os: 'win32', arch: 'arm64', pythonArch: 'x86-emulated' },
      recommended: LLM_QWEN25_3B_HF,
      alternatives: [],
      caveats: ['x86 Python 运行在 ARM 模拟层上，性能比原生略低'],
    },
    {
      match: { os: ['win32', 'linux'], arch: 'x64', gpu: ['cuda', 'rocm'] },
      recommended: LLM_QWEN25_7B_HF,
      alternatives: [LLM_QWEN25_3B_HF],
      caveats: ['7B 模型需 ≥12GB 显存'],
    },
    {
      match: { os: ['win32', 'linux'], arch: 'x64', gpu: 'none' },
      recommended: LLM_QWEN25_3B_HF,
      alternatives: [],
      caveats: ['纯 CPU 上 3B 模型生成偏慢（~5 tok/s）'],
    },
  ],
};
