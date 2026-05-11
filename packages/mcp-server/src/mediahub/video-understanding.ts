/**
 * MediaHub — Video Understanding (Phase 4B)
 * Pluggable analyzers: Gemini + Zhipu VLM.
 */

import { readFile, stat } from 'node:fs/promises';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_ZHIPU_MODEL = 'glm-4.1v-thinking-flash';
const DEFAULT_INLINE_LIMIT_BYTES = 20 * 1024 * 1024; // 20 MB
const DEFAULT_ANALYSIS_PROMPT =
  'Describe this video in concise production terms and assess quality for social media publishing.';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

interface ZhipuResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

export interface VideoAnalysis {
  summary: string;
  keyMoments: string[];
  styleTags: string[];
  qualityScore: number | null;
  issues: string[];
  recommendRegenerate: boolean;
  regeneratePrompt?: string;
}

export type VideoUnderstandingProvider = 'gemini' | 'zhipu';

export interface AnalyzeVideoInput {
  provider?: VideoUnderstandingProvider | 'auto';
  localPath?: string;
  publicUrl?: string;
  mimeType: string;
  prompt?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AnalyzeVideoOutput {
  provider: VideoUnderstandingProvider;
  model: string;
  method: 'inline_video' | 'file_uri';
  source: { localPath?: string; publicUrl?: string; mimeType: string };
  analysis: VideoAnalysis;
  rawText: string;
}

function getGeminiApiKey(): string | undefined {
  return process.env['GOOGLE_AI_API_KEY'] ?? process.env['GEMINI_API_KEY'];
}

function getZhipuApiKey(): string | undefined {
  return process.env['ZHIPU_API_KEY'] ?? process.env['COGVIDEO_API_KEY'] ?? process.env['BIGMODEL_API_KEY'];
}

function extractGeminiText(payload: GeminiResponse): string {
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text?.trim())
    .filter((v): v is string => Boolean(v))
    .join('\n')
    .trim();
}

function extractZhipuText(payload: ZhipuResponse): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' ? part.text?.trim() : ''))
    .filter((v): v is string => Boolean(v))
    .join('\n')
    .trim();
}

function unwrapJsonFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
    .slice(0, limit);
}

function normalizeScore(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.round(value);
}

function parseVideoAnalysis(rawText: string): VideoAnalysis {
  const text = unwrapJsonFence(rawText);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const summary = typeof parsed['summary'] === 'string' ? parsed['summary'].trim() : '';
    const keyMoments = normalizeStringArray(parsed['keyMoments'], 6);
    const styleTags = normalizeStringArray(parsed['styleTags'], 10);
    const issues = normalizeStringArray(parsed['issues'], 10);
    const qualityScore = normalizeScore(parsed['qualityScore']);
    const recommendRegenerate =
      typeof parsed['recommendRegenerate'] === 'boolean'
        ? parsed['recommendRegenerate']
        : qualityScore !== null
          ? qualityScore < 70
          : issues.length > 0;
    const regeneratePrompt =
      typeof parsed['regeneratePrompt'] === 'string' && parsed['regeneratePrompt'].trim().length > 0
        ? parsed['regeneratePrompt'].trim()
        : undefined;

    return {
      summary: summary || rawText.slice(0, 800),
      keyMoments,
      styleTags,
      qualityScore,
      issues,
      recommendRegenerate,
      regeneratePrompt,
    };
  } catch {
    return {
      summary: rawText.slice(0, 1200),
      keyMoments: [],
      styleTags: [],
      qualityScore: null,
      issues: [],
      recommendRegenerate: false,
    };
  }
}

function buildInstruction(prompt?: string): string {
  const focus = (prompt?.trim() || DEFAULT_ANALYSIS_PROMPT).slice(0, 1000);
  return (
    `Task: ${focus}\n\n` +
    'Return STRICT JSON with fields:\n' +
    '- summary: string (<= 220 chars)\n' +
    '- keyMoments: string[] (3-6 bullet-like items)\n' +
    '- styleTags: string[] (up to 10 tags)\n' +
    '- qualityScore: number (0-100)\n' +
    '- issues: string[] (empty when none)\n' +
    '- recommendRegenerate: boolean\n' +
    '- regeneratePrompt: string (optional)'
  );
}

async function resolveVideoSource(input: AnalyzeVideoInput): Promise<{
  method: 'inline_video' | 'file_uri';
  inlineData?: string;
  publicUrl?: string;
}> {
  const inlineLimitRaw = Number(process.env['MEDIAHUB_INLINE_LIMIT_BYTES'] ?? DEFAULT_INLINE_LIMIT_BYTES);
  const inlineLimit = Number.isFinite(inlineLimitRaw) && inlineLimitRaw > 0 ? inlineLimitRaw : DEFAULT_INLINE_LIMIT_BYTES;

  if (input.localPath) {
    const fileStat = await stat(input.localPath);
    if (fileStat.size <= inlineLimit) {
      const data = await readFile(input.localPath);
      return { method: 'inline_video', inlineData: data.toString('base64') };
    }
    if (input.publicUrl) return { method: 'file_uri', publicUrl: input.publicUrl };
    throw new Error(
      `Video exceeds inline limit (${fileStat.size} bytes > ${inlineLimit}) and no public URL fallback is available`,
    );
  }
  if (input.publicUrl) return { method: 'file_uri', publicUrl: input.publicUrl };
  throw new Error('Either localPath or publicUrl must be provided');
}

async function analyzeWithGemini(input: AnalyzeVideoInput): Promise<AnalyzeVideoOutput> {
  const apiKey = input.apiKey ?? getGeminiApiKey();
  if (!apiKey) throw new Error('Gemini API key missing (GEMINI_API_KEY / GOOGLE_AI_API_KEY)');

  const model = input.model?.trim() || process.env['MEDIAHUB_GEMINI_MODEL'] || DEFAULT_GEMINI_MODEL;
  const source = await resolveVideoSource(input);

  const videoPart: GeminiPart =
    source.method === 'inline_video'
      ? { inlineData: { mimeType: input.mimeType, data: source.inlineData ?? '' } }
      : { fileData: { mimeType: input.mimeType, fileUri: source.publicUrl ?? '' } };

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [videoPart, { text: buildInstruction(input.prompt) }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini analyze failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as GeminiResponse;
  const rawText = extractGeminiText(payload);
  if (!rawText) throw new Error('Gemini returned empty analysis');

  return {
    provider: 'gemini',
    model,
    method: source.method,
    source: { localPath: input.localPath, publicUrl: input.publicUrl, mimeType: input.mimeType },
    analysis: parseVideoAnalysis(rawText),
    rawText,
  };
}

async function analyzeWithZhipu(input: AnalyzeVideoInput): Promise<AnalyzeVideoOutput> {
  const apiKey = input.apiKey ?? getZhipuApiKey();
  if (!apiKey) throw new Error('Zhipu API key missing (ZHIPU_API_KEY / COGVIDEO_API_KEY / BIGMODEL_API_KEY)');

  const model = input.model?.trim() || process.env['MEDIAHUB_ZHIPU_MODEL'] || DEFAULT_ZHIPU_MODEL;
  const baseUrl = (input.baseUrl?.trim() || process.env['MEDIAHUB_ZHIPU_BASE_URL'] || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const source = await resolveVideoSource(input);

  // Zhipu multimodal currently works best with URL-style input.
  const urlPayload =
    source.method === 'file_uri'
      ? source.publicUrl
      : source.inlineData
        ? `data:${input.mimeType};base64,${source.inlineData}`
        : undefined;
  if (!urlPayload) {
    throw new Error('Failed to construct video payload for Zhipu analyzer');
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildInstruction(input.prompt) },
            { type: 'video_url', video_url: { url: urlPayload } },
          ],
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Zhipu analyze failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as ZhipuResponse;
  const rawText = extractZhipuText(payload);
  if (!rawText) throw new Error('Zhipu returned empty analysis');

  return {
    provider: 'zhipu',
    model,
    method: source.method,
    source: { localPath: input.localPath, publicUrl: input.publicUrl, mimeType: input.mimeType },
    analysis: parseVideoAnalysis(rawText),
    rawText,
  };
}

export async function analyzeVideoWithProvider(input: AnalyzeVideoInput): Promise<AnalyzeVideoOutput> {
  const provider = input.provider ?? 'auto';
  if (provider === 'gemini') return analyzeWithGemini(input);
  if (provider === 'zhipu') return analyzeWithZhipu(input);

  // auto: prefer Gemini when configured, then fallback to Zhipu.
  if (input.apiKey || getGeminiApiKey()) {
    try {
      return await analyzeWithGemini(input);
    } catch (err) {
      const zhipuAvailable = Boolean(getZhipuApiKey());
      if (!zhipuAvailable) throw err;
    }
  }
  return analyzeWithZhipu(input);
}

export async function analyzeVideoWithGemini(input: AnalyzeVideoInput): Promise<AnalyzeVideoOutput> {
  return analyzeWithGemini(input);
}
