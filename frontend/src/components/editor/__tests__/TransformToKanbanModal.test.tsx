import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  hold: new Map<string, Promise<void>>(),
  liveSubs: new Set<() => void>(),
  createCard: vi.fn(),
  createBoard: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
/* eslint-disable react-hooks/exhaustive-deps -- il mock riproduce le deps dinamiche di Dexie */
vi.mock('dexie-react-hooks', async () => {
  const { useEffect, useState } = await import('react');
  return {
    useLiveQuery: (fn: () => Promise<unknown>, deps: unknown[] = []) => {
      const [v, setV] = useState<unknown>(undefined);
      const [tick, setTick] = useState(0);
      useEffect(() => {
        const bump = () => setTick((n) => n + 1);
        h.liveSubs.add(bump);
        return () => { h.liveSubs.delete(bump); };
      }, []);
      useEffect(() => {
        let cancelled = false;
        void Promise.resolve(fn()).then(async (result) => {
          const gate = h.hold.get(String(deps[0]));
          if (gate) await gate;
          if (!cancelled) setV(result);
        });
        return () => { cancelled = true; };
      }, [...deps, tick]);
      return v;
    },
  };
});
/* eslint-enable react-hooks/exhaustive-deps */

vi.mock('../../../lib/db', () => ({
  db: {
    kanbanColumns: {
      where: () => ({
        equals: (boardId: string) => ({
          sortBy: async () => boardId === 'A'
            ? [{ id: 'colA', title: 'ColA', boardId: 'A', position: 0 }]
            : [{ id: 'colB', title: 'ColB', boardId: 'B', position: 0 }],
        }),
      }),
    },
    kanbanCards: {
      where: () => ({ equals: () => ({ toArray: async () => [] }) }),
    },
    kanbanBoards: {
      get: async (boardId: string) => ({ id: boardId, title: `Board ${boardId}` }),
    },
  },
}));
vi.mock('../../../features/kanban/hooks/useKanbanBoards', () => ({
  useKanbanBoards: () => ({ data: [{ id: 'A', title: 'Board A' }, { id: 'B', title: 'Board B' }], isLoading: false }),
}));
vi.mock('../../../features/kanban/hooks/useKanbanBoard', () => ({
  useKanbanBoard: () => ({ data: undefined, isLoading: true }),
}));
vi.mock('../../../features/kanban/hooks/useKanbanMutations', () => ({
  useKanbanMutations: () => ({ createCard: { mutateAsync: h.createCard }, createBoard: { mutateAsync: h.createBoard } }),
}));

import TransformToKanbanModal from '../TransformToKanbanModal';

const editor = { chain: () => ({ deleteRange: vi.fn(), run: vi.fn() }) } as never;
const items = [{ text: 'Task', from: 1, to: 2 }];

function gateFor(boardId: string) {
  let release!: () => void;
  h.hold.set(boardId, new Promise<void>((resolve) => { release = resolve; }));
  return release;
}

async function chooseBoard(title: string) {
  fireEvent.click(screen.getByText(title));
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.hold.clear();
  h.liveSubs.clear();
  h.createCard.mockResolvedValue({});
  h.createBoard.mockResolvedValue({ id: 'new-board' });
});

describe('TransformToKanbanModal stale board result', () => {
  it('does not show the previous board columns while the selected board query is pending', async () => {
    render(<TransformToKanbanModal isOpen onClose={() => {}} items={items} editor={editor} />);
    await chooseBoard('Board A');
    expect(await screen.findByText('ColA')).toBeTruthy();
    gateFor('');
    gateFor('B');
    fireEvent.click(screen.getByText('common.back'));
    await chooseBoard('Board B');
    expect(screen.queryByText('ColA')).toBeNull();
    expect(screen.getByText('common.loading')).toBeTruthy();
  });

  it('creates cards only in the selected board after its query arrives', async () => {
    render(<TransformToKanbanModal isOpen onClose={() => {}} items={items} editor={editor} />);
    await chooseBoard('Board A');
    expect(await screen.findByText('ColA')).toBeTruthy();
    gateFor('');
    const releaseB = gateFor('B');
    fireEvent.click(screen.getByText('common.back'));
    await chooseBoard('Board B');
    expect(screen.queryByRole('button', { name: /ColA/ })).toBeNull();
    expect(h.createCard).not.toHaveBeenCalled();
    await act(async () => { releaseB(); await Promise.resolve(); });
    fireEvent.click(await screen.findByRole('button', { name: /ColB/ }));
    expect(h.createCard).toHaveBeenCalledWith({ columnId: 'colB', title: 'Task', description: undefined });
  });

  it('keeps the normal existing-board flow', async () => {
    render(<TransformToKanbanModal isOpen onClose={() => {}} items={items} editor={editor} />);
    await chooseBoard('Board A');
    fireEvent.click(await screen.findByRole('button', { name: /ColA/ }));
    expect(h.createCard).toHaveBeenCalledWith({ columnId: 'colA', title: 'Task', description: undefined });
  });
});
