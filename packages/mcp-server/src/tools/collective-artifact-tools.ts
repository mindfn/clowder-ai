import { collectiveArtifactCallbackCommandSchema } from '@cat-cafe/shared';
import type { z } from 'zod';
import { callbackPost } from './callback-tools.js';

export const collectiveArtifactCommandInputSchema = collectiveArtifactCallbackCommandSchema.shape;
export const handleCollectiveArtifactCommand = (input: z.infer<typeof collectiveArtifactCallbackCommandSchema>) =>
  callbackPost('/api/callbacks/collective-artifact-command', input);
