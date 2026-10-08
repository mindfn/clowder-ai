import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseMediaByteRange } from './media-byte-range.js';

/** The caller has already checked the workspace root, path, MIME and size policy. */
export function sendWorkspaceMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  byteLength: number,
  mime: string,
) {
  reply.header('Content-Type', mime).header('Cache-Control', 'private, max-age=60').header('Accept-Ranges', 'bytes');
  const range = request.headers.range;
  if (!range) return reply.header('Content-Length', byteLength).send(createReadStream(filePath));

  const parsed = parseMediaByteRange(range, byteLength);
  if (!parsed) return reply.code(416).header('Content-Range', `bytes */${byteLength}`).send();

  return reply
    .code(206)
    .header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${byteLength}`)
    .header('Content-Length', parsed.end - parsed.start + 1)
    .send(createReadStream(filePath, parsed));
}
