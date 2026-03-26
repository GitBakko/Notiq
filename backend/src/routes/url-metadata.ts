import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const querySchema = z.object({
  url: z.string().url(),
});

// SSRF protection: block requests to internal/private networks
const BLOCKED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254']);
const PRIVATE_IP_PREFIXES = ['10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.',
  '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.', '0.', 'fd', 'fe80:'];

function isInternalUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (BLOCKED_HOSTNAMES.has(parsed.hostname)) return true;
    if (PRIVATE_IP_PREFIXES.some(prefix => parsed.hostname.startsWith(prefix))) return true;
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return true;
    return false;
  } catch {
    return true;
  }
}

export default async function (fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // Fetch page title + favicon from a URL
  fastify.get('/', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { url } = querySchema.parse(request.query);

    if (isInternalUrl(url)) {
      return reply.status(400).send({ message: 'errors.urlMetadata.blockedUrl' });
    }

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
        return reply.status(502).send({ message: 'errors.urlMetadata.fetchFailed' });
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
          const resolved = new URL(iconMatch[1], url).href;
          faviconUrl = isInternalUrl(resolved) ? null : resolved;
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
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return reply.status(504).send({ message: 'errors.urlMetadata.fetchTimeout' });
      }
      request.log.warn({ err, url }, 'Failed to fetch URL metadata');
      return reply.status(502).send({ message: 'errors.urlMetadata.fetchFailed' });
    }
  });

  // Proxy screenshot from thum.io — returns base64 image
  fastify.get('/screenshot', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { url } = querySchema.parse(request.query);

    if (isInternalUrl(url)) {
      return reply.status(400).send({ message: 'errors.urlMetadata.blockedUrl' });
    }

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
        return reply.status(502).send({ message: 'errors.urlMetadata.screenshotFailed' });
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Cap at 500KB to avoid bloating encrypted credential data
      if (buffer.length > 500 * 1024) {
        return reply.status(413).send({ message: 'errors.urlMetadata.screenshotTooLarge' });
      }

      const contentType = response.headers.get('content-type') || 'image/png';
      const base64 = buffer.toString('base64');

      return { screenshotBase64: `data:${contentType};base64,${base64}` };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return reply.status(504).send({ message: 'errors.urlMetadata.screenshotTimeout' });
      }
      request.log.warn({ err, url }, 'Failed to fetch screenshot');
      return reply.status(502).send({ message: 'errors.urlMetadata.screenshotFailed' });
    }
  });
}
