import { vi, describe, it, expect, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import {
  createNotebook,
  getNotebooks,
  getNotebook,
  updateNotebook,
  deleteNotebook,
} from '../notebook.service';

const prismaMock = prisma as any;

const USER_ID = 'user-1';
const NOTEBOOK_ID = 'notebook-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createNotebook', () => {
  it('should create a notebook when no duplicate exists', async () => {
    const created = { id: NOTEBOOK_ID, name: 'Work', userId: USER_ID };
    prismaMock.notebook.findFirst.mockResolvedValue(null);
    prismaMock.notebook.create.mockResolvedValue(created);

    const result = await createNotebook(USER_ID, 'Work');

    expect(prismaMock.notebook.findFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID, name: 'Work' },
    });
    expect(prismaMock.notebook.create).toHaveBeenCalledWith({
      data: { name: 'Work', userId: USER_ID },
    });
    expect(result).toEqual(created);
  });

  it('should create a notebook with a provided id', async () => {
    const customId = 'custom-id';
    const created = { id: customId, name: 'Work', userId: USER_ID };
    prismaMock.notebook.findFirst.mockResolvedValue(null);
    prismaMock.notebook.create.mockResolvedValue(created);

    const result = await createNotebook(USER_ID, 'Work', customId);

    expect(prismaMock.notebook.create).toHaveBeenCalledWith({
      data: { id: customId, name: 'Work', userId: USER_ID },
    });
    expect(result).toEqual(created);
  });

  it('should throw when a notebook with the same name already exists', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue({
      id: 'existing',
      name: 'Work',
      userId: USER_ID,
    });

    await expect(createNotebook(USER_ID, 'Work')).rejects.toThrow(
      'Notebook with this name already exists',
    );
    expect(prismaMock.notebook.create).not.toHaveBeenCalled();
  });
});

describe('getNotebooks', () => {
  it('should return notebooks for a user ordered by updatedAt desc with note count', async () => {
    const notebooks = [
      { id: 'nb-1', name: 'A', _count: { notes: 3 } },
      { id: 'nb-2', name: 'B', _count: { notes: 0 } },
    ];
    prismaMock.notebook.findMany.mockResolvedValue(notebooks);

    const result = await getNotebooks(USER_ID);

    expect(prismaMock.notebook.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: {
            notes: {
              where: { isVault: false },
            },
          },
        },
      },
    });
    expect(result).toEqual(notebooks);
  });
});

describe('getNotebook', () => {
  it('should return a single notebook matching user and id', async () => {
    const notebook = { id: NOTEBOOK_ID, name: 'Work', userId: USER_ID };
    prismaMock.notebook.findFirst.mockResolvedValue(notebook);

    const result = await getNotebook(USER_ID, NOTEBOOK_ID);

    expect(prismaMock.notebook.findFirst).toHaveBeenCalledWith({
      where: { id: NOTEBOOK_ID, userId: USER_ID },
    });
    expect(result).toEqual(notebook);
  });

  it('should return null when notebook does not exist', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(null);

    const result = await getNotebook(USER_ID, 'non-existent');

    expect(result).toBeNull();
  });
});

describe('updateNotebook', () => {
  it('should update the notebook name scoped to the user', async () => {
    const updateResult = { count: 1 };
    prismaMock.notebook.updateMany.mockResolvedValue(updateResult);

    const result = await updateNotebook(USER_ID, NOTEBOOK_ID, 'Renamed');

    expect(prismaMock.notebook.updateMany).toHaveBeenCalledWith({
      where: { id: NOTEBOOK_ID, userId: USER_ID },
      data: { name: 'Renamed' },
    });
    expect(result).toEqual(updateResult);
  });
});

describe('deleteNotebook', () => {
  it('should move notes to an existing fallback notebook and delete', async () => {
    const notebook = { id: NOTEBOOK_ID, name: 'ToDelete', userId: USER_ID };
    const fallback = { id: 'fallback-id', name: 'Other', userId: USER_ID };

    // The $transaction mock calls the callback with prismaMock itself
    prismaMock.notebook.findFirst
      .mockResolvedValueOnce(notebook)   // find the notebook to delete
      .mockResolvedValueOnce(fallback);  // find fallback notebook
    prismaMock.note.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.notebook.delete.mockResolvedValue(notebook);

    const result = await deleteNotebook(USER_ID, NOTEBOOK_ID);

    expect(prismaMock.notebook.findFirst).toHaveBeenCalledTimes(2);
    expect(prismaMock.note.updateMany).toHaveBeenCalledWith({
      where: { notebookId: NOTEBOOK_ID, userId: USER_ID },
      data: { notebookId: fallback.id },
    });
    expect(prismaMock.notebook.delete).toHaveBeenCalledWith({
      where: { id: NOTEBOOK_ID },
    });
    expect(result).toEqual(notebook);
  });

  it('should create an Uncategorized fallback when no other notebook exists', async () => {
    const notebook = { id: NOTEBOOK_ID, name: 'OnlyOne', userId: USER_ID };
    const createdFallback = { id: 'new-fallback', name: 'Uncategorized', userId: USER_ID };

    prismaMock.notebook.findFirst
      .mockResolvedValueOnce(notebook)  // find the notebook to delete
      .mockResolvedValueOnce(null);     // no other notebook exists
    prismaMock.notebook.create.mockResolvedValue(createdFallback);
    prismaMock.note.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.notebook.delete.mockResolvedValue(notebook);

    const result = await deleteNotebook(USER_ID, NOTEBOOK_ID);

    expect(prismaMock.notebook.create).toHaveBeenCalledWith({
      data: { name: 'Uncategorized', userId: USER_ID },
    });
    expect(prismaMock.note.updateMany).toHaveBeenCalledWith({
      where: { notebookId: NOTEBOOK_ID, userId: USER_ID },
      data: { notebookId: createdFallback.id },
    });
    expect(result).toEqual(notebook);
  });

  it('should throw when the notebook is not found', async () => {
    prismaMock.notebook.findFirst.mockResolvedValue(null);

    await expect(deleteNotebook(USER_ID, 'missing')).rejects.toThrow(
      'Notebook not found',
    );
    expect(prismaMock.notebook.delete).not.toHaveBeenCalled();
  });
});
