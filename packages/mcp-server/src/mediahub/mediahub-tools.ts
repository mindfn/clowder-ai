/**
 * MediaHub — MCP Tool Definitions
 * F139: Exposes MediaHub capabilities as MCP tools.
 */

import { z } from 'zod';
import type { ToolResult } from '../tools/file-tools.js';
import { errorResult, successResult } from '../tools/file-tools.js';
import { tryAutoLoadProvider } from './account-tools.js';
import { guessMimeType, isImageType, isVideoType, validateMediaFile } from './media-lifecycle.js';
import type { MediaHubService } from './mediahub-service.js';
import type { GenerationRequest, MediaCapability } from './types.js';
import { analyzeVideoWithGemini } from './video-understanding.js';

// ============ Lazy service reference ============
// Set by bootstrap; tools use this reference at call time.
let serviceRef: MediaHubService | null = null;

export function setMediaHubService(service: MediaHubService): void {
  serviceRef = service;
}

function getService(): MediaHubService {
  if (!serviceRef) {
    throw new Error('MediaHub service not initialized');
  }
  return serviceRef;
}

// ============ Tool: list_providers ============

export const listProvidersInputSchema = {};

export async function handleListProviders(): Promise<ToolResult> {
  try {
    const providers = getService().listProviders();
    if (providers.length === 0) {
      return successResult(
        'No providers registered. Configure at least one provider API key ' +
          '(e.g. COGVIDEO_API_KEY) and restart the MCP server.',
      );
    }
    return successResult(JSON.stringify(providers, null, 2));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: generate_video ============

export const generateVideoInputSchema = {
  provider: z
    .string()
    .describe('Provider ID (e.g. "cogvideox", "kling"). Use mediahub_list_providers to see available providers.'),
  prompt: z.string().min(1).describe('Text prompt describing the video to generate'),
  capability: z
    .enum(['text2video', 'image2video', 'text2image', 'image2image'])
    .default('text2video')
    .describe('Generation type. Default: text2video'),
  model: z.string().optional().describe('Model name override. If omitted, uses provider default.'),
  image_url: z.string().optional().describe('Reference image URL for image2video / image2image'),
  duration: z.number().optional().describe('Video duration in seconds (provider-dependent)'),
  aspect_ratio: z.string().optional().describe('Aspect ratio e.g. "16:9", "9:16", "1:1"'),
  negative_prompt: z.string().optional().describe('What to avoid in the generation'),
};

export async function handleGenerateVideo(args: {
  provider: string;
  prompt: string;
  capability?: string;
  model?: string;
  image_url?: string;
  duration?: number;
  aspect_ratio?: string;
  negative_prompt?: string;
}): Promise<ToolResult> {
  try {
    const request: GenerationRequest = {
      providerId: args.provider,
      prompt: args.prompt,
      capability: (args.capability ?? 'text2video') as MediaCapability,
      model: args.model,
      imageUrl: args.image_url,
      duration: args.duration,
      aspectRatio: args.aspect_ratio,
      negativePrompt: args.negative_prompt,
    };

    // Lazy-load: if provider was bound via Console but not yet registered in this process
    await tryAutoLoadProvider(args.provider);
    const job = await getService().generateVideo(request);

    // Progress card block for the cat to send via cat_cafe_create_rich_block
    const progressBlock = {
      id: `mh-prog-${job.jobId.slice(0, 8)}`,
      kind: 'card',
      v: 1,
      title: job.status === 'failed' ? 'Generation Failed' : 'Generating...',
      tone: job.status === 'failed' ? 'danger' : 'info',
      bodyMarkdown: job.status === 'failed'
        ? `**${job.providerId}** / ${job.model}\n\nError: ${job.error}`
        : `**${job.providerId}** / ${job.model}\n\nPrompt: ${args.prompt.slice(0, 100)}\n\nStatus: queued`,
      fields: [
        { label: 'Job', value: job.jobId.slice(0, 8) },
        { label: 'Status', value: job.status },
      ],
    };

    return successResult(
      JSON.stringify(
        {
          jobId: job.jobId,
          status: job.status,
          provider: job.providerId,
          model: job.model,
          error: job.error,
          progressBlock,
          message:
            job.status === 'failed'
              ? `Generation failed: ${job.error}`
              : `Job submitted. IMMEDIATELY call cat_cafe_create_rich_block with the progressBlock above to show the user that generation has started. Then poll with mediahub_get_job_status.`,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: generate_image ============

export const generateImageInputSchema = {
  provider: z.string().describe('Provider ID (e.g. "jimeng"). Use mediahub_list_providers to see available providers.'),
  prompt: z.string().min(1).describe('Text prompt describing the image to generate'),
  capability: z
    .enum(['text2image', 'image2image'])
    .default('text2image')
    .describe('Generation type. Default: text2image'),
  model: z.string().optional().describe('Model name override'),
  image_url: z.string().optional().describe('Reference image URL for image2image'),
  aspect_ratio: z.string().optional().describe('Aspect ratio e.g. "16:9", "1:1"'),
  negative_prompt: z.string().optional().describe('What to avoid in the generation'),
};

// ============ Tool: send_media ============

export const sendMediaInputSchema = {
  job_id: z.string().describe('Job ID of a succeeded generation job'),
};

export async function handleSendMedia(args: { job_id: string }): Promise<ToolResult> {
  try {
    // Trigger terminal-status backfill (e.g. late local download for already-succeeded jobs).
    await getService().getJobStatus(args.job_id);

    const job = await getService().getJob(args.job_id);
    if (!job) return errorResult(`Job "${args.job_id}" not found`);
    if (job.status !== 'succeeded') {
      return errorResult(`Job "${args.job_id}" status is "${job.status}" — only succeeded jobs can be sent`);
    }

    // Validate local file if available (non-blocking when CDN URL exists)
    let fileValidation: import('./media-lifecycle.js').MediaValidation | undefined;
    if (job.outputPath) {
      fileValidation = validateMediaFile(job.outputPath);
      if (!fileValidation.valid && !job.providerResultUrl) {
        return errorResult(`Media validation failed: ${fileValidation.error}`);
      }
    }

    // Resolve serve URL: prefer local API route for reliable in-console playback.
    let url: string | undefined;
    if (job.outputPath) {
      // Extract relative path under data/mediahub/outputs/ for local serve
      const marker = 'data/mediahub/outputs/';
      const idx = job.outputPath.indexOf(marker);
      if (idx >= 0) {
        const relative = job.outputPath.slice(idx + marker.length);
        url = `/api/mediahub/media/${relative}`;
      }
    }
    if (!url) {
      url = job.providerResultUrl;
    }
    if (!url) return errorResult('No media URL or file path available');

    const mime = fileValidation?.valid ? fileValidation.mimeType : guessMimeType(url);
    let block: Record<string, unknown>;
    if (isImageType(mime)) {
      block = {
        id: `mh-${job.jobId.slice(0, 8)}`,
        kind: 'media_gallery',
        v: 1,
        title: `Generated: ${job.prompt.slice(0, 60)}`,
        items: [{ url, alt: job.prompt.slice(0, 100), caption: `${job.providerId} / ${job.model}` }],
      };
    } else if (isVideoType(mime)) {
      block = {
        id: `mh-${job.jobId.slice(0, 8)}`,
        kind: 'video',
        v: 1,
        url,
        title: `Generated: ${job.prompt.slice(0, 60)}`,
        mimeType: mime,
      };
    } else {
      block = {
        id: `mh-${job.jobId.slice(0, 8)}`,
        kind: 'file',
        v: 1,
        url,
        fileName: `${job.providerId}-${job.jobId.slice(0, 8)}${url.match(/\.\w+$/)?.[0] ?? '.mp4'}`,
        mimeType: mime,
      };
    }

    return successResult(
      JSON.stringify({ block, localPath: job.outputPath, cdnUrl: job.providerResultUrl, prompt: job.prompt }, null, 2),
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: get_job_status ============

export const getJobStatusInputSchema = {
  job_id: z.string().describe('Job ID returned by mediahub_generate_video'),
};

export async function handleGetJobStatus(args: { job_id: string }): Promise<ToolResult> {
  try {
    const result = await getService().getJobStatus(args.job_id);
    const status = (result as unknown as Record<string, unknown>).status as string;
    const hint =
      status === 'succeeded'
        ? 'Job succeeded! Call mediahub_send_media now, then cat_cafe_create_rich_block with the returned block.'
        : status === 'failed' || status === 'timeout'
          ? 'Job failed. Inform the user.'
          : 'Still in progress. Wait a few seconds, then poll again.';
    return successResult(JSON.stringify({ ...(result as unknown as Record<string, unknown>), _hint: hint }, null, 2));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: analyze_video ============

export const analyzeVideoInputSchema = {
  job_id: z.string().optional().describe('Succeeded MediaHub job ID to analyze (preferred)'),
  video_url: z.string().url().optional().describe('Public video URL to analyze if no job_id is provided'),
  prompt: z.string().optional().describe('Optional analysis focus (e.g. pacing, style, ad readiness)'),
  model: z.string().optional().describe('Gemini model override (default: gemini-2.5-flash)'),
};

function buildLocalServeUrl(outputPath: string): string | undefined {
  const marker = 'data/mediahub/outputs/';
  const idx = outputPath.indexOf(marker);
  if (idx < 0) return undefined;
  const relative = outputPath.slice(idx + marker.length);
  return `/api/mediahub/media/${relative}`;
}

export async function handleAnalyzeVideo(args: {
  job_id?: string;
  video_url?: string;
  prompt?: string;
  model?: string;
}): Promise<ToolResult> {
  try {
    if (!args.job_id && !args.video_url) {
      return errorResult('Either job_id or video_url is required');
    }

    let localPath: string | undefined;
    let publicUrl = args.video_url;
    let mimeType = publicUrl ? guessMimeType(publicUrl) : 'video/mp4';
    let sourceJob: { jobId: string; providerId: string; model: string } | undefined;

    if (args.job_id) {
      await getService().getJobStatus(args.job_id);
      const job = await getService().getJob(args.job_id);
      if (!job) return errorResult(`Job "${args.job_id}" not found`);
      if (job.status !== 'succeeded') {
        return errorResult(`Job "${args.job_id}" status is "${job.status}" — only succeeded jobs can be analyzed`);
      }

      sourceJob = { jobId: job.jobId, providerId: job.providerId, model: job.model };
      localPath = job.outputPath;
      publicUrl = publicUrl ?? job.providerResultUrl;

      if (localPath) {
        const validation = validateMediaFile(localPath);
        if (!validation.valid) return errorResult(`Media validation failed: ${validation.error}`);
        if (!isVideoType(validation.mimeType)) {
          return errorResult(`Only video analysis is supported. Current MIME: ${validation.mimeType}`);
        }
        mimeType = validation.mimeType;
        publicUrl = publicUrl ?? buildLocalServeUrl(localPath);
      } else if (publicUrl) {
        mimeType = guessMimeType(publicUrl);
      } else {
        return errorResult('Job has no outputPath and no providerResultUrl to analyze');
      }
    }

    if (!publicUrl && !localPath) {
      return errorResult('No analyzable video source found');
    }
    if (!isVideoType(mimeType)) {
      return errorResult(`Only video files are supported. MIME: ${mimeType}`);
    }

    const analysis = await analyzeVideoWithGemini({
      localPath,
      publicUrl,
      mimeType,
      prompt: args.prompt,
      model: args.model,
    });

    const hint = analysis.analysis.recommendRegenerate
      ? '建议重生成：根据 issues/regeneratePrompt 调整 prompt 后再次生成。'
      : '质量可接受：可直接用于发布或进入下一步风格对齐。';

    return successResult(
      JSON.stringify(
        {
          sourceJob,
          source: { localPath, publicUrl, mimeType },
          analysis: analysis.analysis,
          provider: analysis.provider,
          model: analysis.model,
          method: analysis.method,
          _hint: hint,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool: list_jobs ============

export const listJobsInputSchema = {
  limit: z.number().default(10).describe('Max number of jobs to return (default: 10)'),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'timeout']).optional().describe('Filter by job status'),
  provider: z.string().optional().describe('Filter by provider ID'),
  capability: z
    .enum(['text2video', 'image2video', 'text2image', 'image2image'])
    .optional()
    .describe('Filter by generation capability'),
};

export async function handleListJobs(args: {
  limit?: number;
  status?: string;
  provider?: string;
  capability?: string;
}): Promise<ToolResult> {
  try {
    const filters =
      args.status || args.provider || args.capability
        ? {
            status: args.status as import('./types.js').JobStatus | undefined,
            provider: args.provider,
            capability: args.capability as import('./types.js').MediaCapability | undefined,
          }
        : undefined;
    const jobs = await getService().listJobs(args.limit ?? 10, filters);
    if (jobs.length === 0) {
      return successResult('No jobs found. Use mediahub_generate_video to create one.');
    }
    const summary = jobs.map((j) => ({
      jobId: j.jobId,
      provider: j.providerId,
      status: j.status,
      prompt: j.prompt.slice(0, 80),
      createdAt: new Date(j.createdAt).toISOString(),
    }));
    return successResult(JSON.stringify(summary, null, 2));
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

// ============ Tool Definitions Array ============

export const mediahubTools = [
  {
    name: 'mediahub_list_providers',
    description:
      'List all available MediaHub providers and their capabilities (video/image generation models). ' +
      'Shows provider ID, supported models, auth mode, and notes.',
    inputSchema: listProvidersInputSchema,
    handler: handleListProviders,
  },
  {
    name: 'mediahub_generate_video',
    description:
      'Submit a video generation job to a MediaHub provider. Returns a job ID + progressBlock. ' +
      'WORKFLOW: (1) Call this tool. (2) IMMEDIATELY call cat_cafe_create_rich_block with the returned progressBlock ' +
      'to show the user that generation has started. (3) Poll mediahub_get_job_status until succeeded. ' +
      '(4) Call mediahub_send_media. (5) Call cat_cafe_create_rich_block with the video block. ' +
      'Video generation is async and typically takes 30s-5min.',
    inputSchema: generateVideoInputSchema,
    handler: handleGenerateVideo,
  },
  {
    name: 'mediahub_generate_image',
    description:
      'Submit an image generation job to a MediaHub provider. ' +
      'Returns a job ID for tracking. Use mediahub_get_job_status to poll for completion.',
    inputSchema: generateImageInputSchema,
    handler: handleGenerateVideo, // same lifecycle as video — capability drives the difference
  },
  {
    name: 'mediahub_send_media',
    description:
      'Prepare a completed MediaHub job for IM delivery. Validates the output file (type/size), ' +
      'then returns a Rich Block JSON (video, media_gallery, or file) for cat_cafe_create_rich_block. ' +
      'Only works on succeeded jobs. ' +
      'IMPORTANT: After calling this tool, you MUST immediately call cat_cafe_create_rich_block ' +
      'with the returned block JSON to display the media inline in the chat. Do not just show the block as text.',
    inputSchema: sendMediaInputSchema,
    handler: handleSendMedia,
  },
  {
    name: 'mediahub_get_job_status',
    description:
      'Check the status of a MediaHub generation job. Polls the provider for progress. ' +
      'When status is "succeeded", outputPath contains the local file path. ' +
      'Call this periodically until status is terminal (succeeded/failed/timeout). ' +
      'Once succeeded, call mediahub_send_media → cat_cafe_create_rich_block to display the media inline. ' +
      'Optionally call mediahub_analyze_video for automatic quality assessment.',
    inputSchema: getJobStatusInputSchema,
    handler: handleGetJobStatus,
  },
  {
    name: 'mediahub_analyze_video',
    description:
      'Analyze a generated video (or public video URL) with Gemini. ' +
      'Returns structured JSON: summary, key moments, style tags, quality score, issues, and regenerate recommendation. ' +
      'Use this after mediahub_get_job_status returns succeeded.',
    inputSchema: analyzeVideoInputSchema,
    handler: handleAnalyzeVideo,
  },
  {
    name: 'mediahub_list_jobs',
    description: 'List recent MediaHub generation jobs. Supports filtering by status, provider, and capability.',
    inputSchema: listJobsInputSchema,
    handler: handleListJobs,
  },
] as const;
