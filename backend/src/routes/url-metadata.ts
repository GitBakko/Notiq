import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const querySchema = z.object({
  url: z.string().url(),
});

export default async function (fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Fetch page title + favicon from a URL
  fastify.get('/', async (request, reply) => {
    const { url } = querySchema.parse(request.query);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Notiq/1.0)',
          'Accept': 'text/html',
        },
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return reply.status(502).send({ message: 'Failed to fetch URL' });
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        return { title: null, faviconUrl: null };
      }

      // Only read first 50KB to extract metadata
      const reader = response.body?.getReader();
      if (!reader) return { title: null, faviconUrl: null };

      let html = '';
      const decoder = new TextDecoder();
      let bytesRead = 0;
      const MAX_BYTES = 50 * 1024;

      while (bytesRead < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytesRead += value.length;
        // Stop early if we've found </head>
        if (html.includes('</head>')) break;
      }
      reader.cancel();

      // Extract title
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i);
      const title = (titleMatch?.[1] || ogTitleMatch?.[1] || '').trim().replace(/\s+/g, ' ');

      // Extract favicon
      let faviconUrl: string | null = null;
      const iconMatch = html.match(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']*)["']/i)
        || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["'](?:shortcut )?icon["']/i);

      if (iconMatch?.[1]) {
        // Resolve relative URLs using URL API (handles ./relative, //protocol, /absolute, etc.)
        try {
          faviconUrl = new URL(iconMatch[1], url).href;
        } catch {
          faviconUrl = null;
        }
      }

      // Fallback: try /favicon.ico
      if (!faviconUrl) {
        const origin = new URL(url).origin;
        faviconUrl = origin + '/favicon.ico';
      }

      return { title: title || null, faviconUrl };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return reply.status(504).send({ message: 'URL fetch timed out' });
      }
      request.log.warn({ err, url }, 'Failed to fetch URL metadata');
      return reply.status(502).send({ message: 'Failed to fetch URL' });
    }
  });

  // Proxy screenshot from thum.io — returns base64 image
  fastify.get('/screenshot', async (request, reply) => {
    const { url } = querySchema.parse(request.query);

    try {
      const thumbUrl = `https://image.thum.io/get/width/400/crop/600/wait/5/noanimate/${url}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000); // 45s — thum.io can be slow for new pages

      const response = await fetch(thumbUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Notiq/1.0)',
        },
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return reply.status(502).send({ message: 'Failed to fetch screenshot' });
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Cap at 500KB to avoid bloating encrypted credential data
      if (buffer.length > 500 * 1024) {
        return reply.status(413).send({ message: 'Screenshot too large' });
      }

      const contentType = response.headers.get('content-type') || 'image/png';
      const base64 = buffer.toString('base64');

      return { screenshotBase64: `data:${contentType};base64,${base64}` };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return reply.status(504).send({ message: 'Screenshot timed out' });
      }
      request.log.warn({ err, url }, 'Failed to fetch screenshot');
      return reply.status(502).send({ message: 'Failed to fetch screenshot' });
    }
  });
}
