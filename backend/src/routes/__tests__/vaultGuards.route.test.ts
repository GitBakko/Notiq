import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';

vi.mock('../../services/import.service', () => ({ importFromEnex: vi.fn() }));
vi.mock('../../services/onenote-import.service', () => ({ importFromOneNote: vi.fn() }));
vi.mock('../../services/attachment.service', () => ({
  saveAttachment: vi.fn(),
  getAttachments: vi.fn(),
  deleteAttachment: vi.fn(),
  getAttachmentHistory: vi.fn(),
  getAttachmentPath: vi.fn(),
}));
vi.mock('../../services/note.service', () => ({ checkNoteAccess: vi.fn() }));
vi.mock('../../services/vault.service', () => ({ getVaultGuard: vi.fn() }));
vi.mock('../../plugins/prisma', () => ({
  default: { note: { findFirst: vi.fn() }, attachment: { findUnique: vi.fn() } },
}));

import * as importService from '../../services/import.service';
import * as onenoteImportService from '../../services/onenote-import.service';
import * as attachmentService from '../../services/attachment.service';
import * as noteService from '../../services/note.service';
import * as vaultService from '../../services/vault.service';
import prisma from '../../plugins/prisma';
import { AppError } from '../../utils/errors';
import importRoutes from '../import';
import { attachmentRoutes } from '../attachments';

const mockEnex = importService.importFromEnex as any;
const mockOneNote = onenoteImportService.importFromOneNote as any;
const mockSave = attachmentService.saveAttachment as any;
const mockAccess = noteService.checkNoteAccess as any;
const mockGuard = vaultService.getVaultGuard as any;
const mockFindNote = (prisma as any).note.findFirst;

const TEST_USER = { id: 'user-1', email: 'test@test.com', role: 'USER', tokenVersion: 0 };
const GUARD = { epoch: 1, ready: true };

let app: FastifyInstance;
let authToken: string;

beforeAll(async () => {
  app = Fastify();
  app.register(jwt, { secret: 'test-secret' });
  app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ message: 'Unauthorized' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.status(error.statusCode).send({ message: error.message });
    reply.status(500).send({ message: error.message });
  });
  app.register(importRoutes, { prefix: '/api/import' });
  app.register(attachmentRoutes, { prefix: '/api/attachments' });
  await app.ready();
  authToken = app.jwt.sign(TEST_USER);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.resetAllMocks();
});

function multipart(filename: string, content: Buffer) {
  const boundary = '----TestBoundary' + Date.now();
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return {
    body: Buffer.concat([Buffer.from(header), content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function post(url: string, withFile = true) {
  const headers: Record<string, string> = { authorization: `Bearer ${authToken}` };
  if (!withFile) return app.inject({ method: 'POST', url, headers });
  const { body, contentType } = multipart('f.bin', Buffer.from('x'));
  return app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': contentType }, payload: body });
}

describe('import + vault guard', () => {
  it.each([
    ['evernote', () => mockEnex],
    ['onenote', () => mockOneNote],
  ])('%s ?isVault=true with keyring -> 422 before reading body', async (kind, svc) => {
    mockGuard.mockResolvedValue(GUARD);
    const res = await post(`/api/import/${kind}?isVault=true`, false);
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).message).toBe('errors.vault.importBlocked');
    expect(svc()).not.toHaveBeenCalled();
    expect(mockGuard).toHaveBeenCalledWith('user-1');
  });

  it('?isVault=true without keyring -> service called', async () => {
    mockGuard.mockResolvedValue(null);
    mockEnex.mockResolvedValue({ imported: 1 });
    mockOneNote.mockResolvedValue({ imported: 1 });
    expect((await post('/api/import/evernote?isVault=true')).statusCode).toBe(200);
    expect((await post('/api/import/onenote?isVault=true')).statusCode).toBe(200);
    expect(mockEnex).toHaveBeenCalledTimes(1);
    expect(mockOneNote).toHaveBeenCalledTimes(1);
  });

  it('without isVault -> getVaultGuard not called', async () => {
    mockEnex.mockResolvedValue({ imported: 1 });
    mockOneNote.mockResolvedValue({ imported: 1 });
    await post('/api/import/evernote');
    await post('/api/import/onenote');
    expect(mockGuard).not.toHaveBeenCalled();
  });
});

describe('attachments POST + vault guard', () => {
  const url = '/api/attachments?noteId=note-1';

  it('vault note of owner with keyring -> 422, saveAttachment not called', async () => {
    mockAccess.mockResolvedValue('OWNER');
    mockFindNote.mockResolvedValue({ id: 'note-1' });
    mockGuard.mockResolvedValue(GUARD);
    const res = await post(url);
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).message).toBe('errors.vault.attachmentsBlocked');
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockGuard).toHaveBeenCalledWith('user-1');
  });

  it('vault note without keyring -> saveAttachment called', async () => {
    mockAccess.mockResolvedValue('OWNER');
    mockFindNote.mockResolvedValue({ id: 'note-1' });
    mockGuard.mockResolvedValue(null);
    mockSave.mockResolvedValue({ id: 'a1' });
    expect((await post(url)).statusCode).toBe(200);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('normal note -> getVaultGuard not called', async () => {
    mockAccess.mockResolvedValue('OWNER');
    mockFindNote.mockResolvedValue(null);
    mockSave.mockResolvedValue({ id: 'a1' });
    expect((await post(url)).statusCode).toBe(200);
    expect(mockFindNote).toHaveBeenCalledWith({ where: { id: 'note-1', userId: 'user-1', isVault: true }, select: { id: true } });
    expect(mockGuard).not.toHaveBeenCalled();
  });

  it('WRITE access (collaborator) -> note.findFirst and getVaultGuard not called, saveAttachment called', async () => {
    mockAccess.mockResolvedValue('WRITE');
    mockSave.mockResolvedValue({ id: 'a1' });
    expect((await post(url)).statusCode).toBe(200);
    expect(mockFindNote).not.toHaveBeenCalled();
    expect(mockGuard).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledTimes(1);
  });
});
