import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { clientIpKey } from '../utils/clientIpKey';

describe('clientIpKey', () => {
  it.each([
    ['1.2.3.4:51234', '1.2.3.4'],
    ['1.2.3.4', '1.2.3.4'],
    ['[2001:db8::1]:4444', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['127.0.0.1', '127.0.0.1'],
    ['::ffff:1.2.3.4', '::ffff:1.2.3.4'],
    ['[::1]', '::1'],
    ['127.0.0.1:51234', '127.0.0.1'],
    ['[::1]:51234', '::1'],
    ['::ffff:1.2.3.4:5', '::ffff:1.2.3.4:5'],
  ])('%s -> %s', (ip, expected) => {
    expect(clientIpKey({ ip })).toBe(expected);
  });

  it('returns empty string when ip is missing', () => {
    expect(clientIpKey({} as any)).toBe('');
  });

  it('rate-limits by client IP behind loopback proxy, ignoring XFF port; loopback without XFF is allowListed', async () => {
    const app = Fastify({ trustProxy: 'loopback' });
    await app.register(rateLimit, {
      global: true,
      max: 1,
      timeWindow: '1 minute',
      keyGenerator: clientIpKey,
      allowList: ['127.0.0.1', '::1'],
    });
    app.get('/x', async () => 'ok');

    const hit = (xff?: string) =>
      app.inject({
        method: 'GET',
        url: '/x',
        remoteAddress: '127.0.0.1',
        headers: xff ? { 'x-forwarded-for': xff } : {},
      });

    expect((await hit('1.2.3.4:1111')).statusCode).toBe(200);
    expect((await hit('1.2.3.4:2222')).statusCode).toBe(429);
    for (let i = 0; i < 3; i++) expect((await hit()).statusCode).toBe(200);
    await app.close();
  });
});
