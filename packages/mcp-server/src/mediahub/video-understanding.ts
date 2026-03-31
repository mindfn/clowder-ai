/**
 * MediaHub — Video Understanding (Phase 4B)
 * Gemini-first video analysis with lightweight fallback strategy.
 */

import { readFile, stat } from 'node:fs/promises';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
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

export interface VideoAnalysis {
  summary: string;
  keyMoments: string[];
  styleTags: string[];
  qualityScore: number | null;
  issues: string[];
  recommendRegenerate: boolean;
  regeneratePrompt?: string;
}

export interface GeminiAnalyzeInput {
  localPath?: string;
  publicUrl?: string;
  mimeType: string;
  prompt?: string;
  model?: string;
}

export interface GeminiAnalyzeOutput {
  provider: 'gemini';
  model: string;
  method: 'inline_video' | 'file_uri';
  source: { localPath?: string; publicUrl?: string; mimeType: string };
  analysis: VideoAnalysis;
  rawText: string;
}

function getGeminiApiKey(): string | undefined {
  return process.env['GOOGLE_AI_API_KEY'] ?? process.env['GEMINI_API_KEY'];
}

function extractCandidateText(payload: GeminiResponse): string {
  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => p.text?.trim())
    .filter((v): v is string => Boolean(v))
    .join('\n')
    .trim();
  return text;
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

async function callGemini(
  apiKey: string,
  model: string,
  videoPart: GeminiPart,
  prompt?: string,
): Promise<{ payload: GeminiResponse; rawText: string }> {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;
  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [videoPart, { text: buildInstruction(prompt) }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini analyze failed (${response.status}): ${errorText}`);
  }
  const payload = (await response.json()) as GeminiResponse;
  const rawText = extractCandidateText(payload);
  if (!rawText) {
    throw new Error('Gemini returned empty analysis');
  }
  return { payload, rawText };
}

export async function analyzeVideoWithGemini(input: GeminiAnalyzeInput): Promise<GeminiAnalyzeOutput> {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY (or GOOGLE_AI_API_KEY) is required for mediahub video analysis');
  }

  const model = input.model?.trim() || process.env['MEDIAHUB_GEMINI_MODEL'] || DEFAULT_GEMINI_MODEL;
  const inlineLimitRaw = Number(process.env['MEDIAHUB_GEMINI_INLINE_LIMIT_BYTES'] ?? DEFAULT_INLINE_LIMIT_BYTES);
  const inlineLimit = Number.isFinite(inlineLimitRaw) && inlineLimitRaw > 0 ? inlineLimitRaw : DEFAULT_INLINE_LIMIT_BYTES;

  let method: GeminiAnalyzeOutput['method'];
  let videoPart: GeminiPart;
  if (input.localPath) {
    const fileStat = await stat(input.localPath);
    if (fileStat.size <= inlineLimit) {
      const data = await readFile(input.localPath);
      videoPart = {
        inlineData: {
          mimeType: input.mimeType,
          data: data.toString('base64'),
        },
      };
      method = 'inline_video';
    } else if (input.publicUrl) {
      videoPart = {
        fileData: {
          mimeType: input.mimeType,
          fileUri: input.publicUrl,
        },
      };
      method = 'file_uri';
    } else {
      throw new Error(
        `Video exceeds inline limit (${fileStat.size} bytes > ${inlineLimit}) and no public URL fallback is available`,
      );
    }
  } else if (input.publicUrl) {
    videoPart = {
      fileData: {
        mimeType: input.mimeType,
        fileUri: input.publicUrl,
      },
    };
    method = 'file_uri';
  } else {
    throw new Error('Either localPath or publicUrl must be provided');
  }

  const { rawText } = await callGemini(apiKey, model, videoPart, input.prompt);

  return {
    provider: 'gemini',
    model,
    method,
    source: {
      localPath: input.localPath,
      publicUrl: input.publicUrl,
      mimeType: input.mimeType,
    },
    analysis: parseVideoAnalysis(rawText),
    rawText,
  };
}
