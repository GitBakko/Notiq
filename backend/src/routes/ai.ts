import { FastifyInstance } from 'fastify';
import {
  streamAiResponse,
  getConversationHistory,
  clearConversation,
  isAiEnabled,
  type AiOperation,
} from '../services/ai.service';
import { checkNoteAccess } from '../services/note.service';

const VALID_OPERATIONS: AiOperation[] = ['ask', 'summarize', 'continue', 'improve', 'tags', 'translate'];

export default async function aiRoutes(fastify: FastifyInstance) {

  // GET /api/ai/status — check if AI is enabled (no API key exposed)
  fastify.get('/status', {
    onRequest: [fastify.authenticate],
  }, async () => {
    const enabled = await isAiEnabled();
    return { enabled };
  });

  // POST /api/ai/chat — SSE streaming endpoint
  fastify.post('/chat', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const { noteId, message, operation, targetLanguage } = request.body as {
      noteId?: string;
      message?: string;
      operation?: string;
      targetLanguage?: string;
    };

    if (!noteId || !message || !operation) {
      return reply.status(400).send({ message: 'noteId, message, and operation are required' });
    }

    const access = await checkNoteAccess(request.user.id, noteId);
    if (!access) return reply.code(403).send({ message: 'Note not found or access denied' });

    if (!VALID_OPERATIONS.includes(operation as AiOperation)) {
      return reply.status(400).send({ message: `Invalid operation. Must be one of: ${VALID_OPERATIONS.join(', ')}` });
    }

    const enabled = await isAiEnabled();
    if (!enabled) {
      return reply.status(503).send({ message: 'AI is not enabled' });
    }

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (type: string, content: string) => {
      reply.raw.write(`data: ${JSON.stringify({ type, content })}\n\n`);
    };

    try {
      await streamAiResponse(
        request.user.id,
        noteId,
        message,
        operation as AiOperation,
        {
          onToken: (token) => sendEvent('token', token),
          onDone: (fullText) => {
            sendEvent('done', fullText);
            reply.raw.end();
          },
          onError: (error) => {
            sendEvent('error', error.message);
            reply.raw.end();
          },
        },
        targetLanguage
      );
    } catch (error: any) {
      sendEvent('error', error.message || 'Unknown error');
      reply.raw.end();
    }
  });

  // GET /api/ai/history/:noteId — get conversation history
  fastify.get('/history/:noteId', {
    onRequest: [fastify.authenticate],
  }, async (request) => {
    const { noteId } = request.params as { noteId: string };
    return getConversationHistory(request.user.id, noteId);
  });

  // DELETE /api/ai/history/:noteId — clear conversation history
  fastify.delete('/history/:noteId', {
    onRequest: [fastify.authenticate],
  }, async (request) => {
    const { noteId } = request.params as { noteId: string };
    await clearConversation(request.user.id, noteId);
    return { success: true };
  });
}
