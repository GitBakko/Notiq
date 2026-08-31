import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoardDnD } from '../useBoardDnD';
import type { KanbanBoard } from '../../types';

/** Minimal board shape: the hook only reads columns[].id / .position / .cards. */
function makeBoard(): KanbanBoard {
  return {
    id: 'board-1',
    columns: [
      {
        id: 'col-a',
        position: 0,
        cards: [
          { id: 'c1', position: 0 },
          { id: 'c2', position: 1 },
        ],
      },
      { id: 'col-b', position: 1, cards: [{ id: 'c3', position: 0 }] },
      { id: 'col-empty', position: 2, cards: [] },
    ],
  } as unknown as KanbanBoard;
}

describe('useBoardDnD.handleMoveCardToColumn', () => {
  function setup() {
    const moveCardMutate = vi.fn();
    const mutations = {
      moveCard: { mutate: moveCardMutate },
      reorderColumns: { mutate: vi.fn() },
    };
    // The board object MUST be built outside the render callback: the hook has a
    // useEffect keyed on board.columns that calls setLocalColumns, so a fresh
    // object per render is an infinite update loop.
    const board = makeBoard();
    const { result } = renderHook(() =>
      useBoardDnD({ board, boardId: 'board-1', mutations }),
    );
    return { result, moveCardMutate };
  }

  it('sends the append index of the target column, not a 999 sentinel', () => {
    const { result, moveCardMutate } = setup();

    act(() => {
      result.current.handleMoveCardToColumn('c1', 'col-b');
    });

    // col-b already holds one card → the card lands at index 1.
    expect(moveCardMutate.mock.calls[0][0]).toEqual({
      cardId: 'c1',
      toColumnId: 'col-b',
      position: 1,
    });
  });

  it('sends index 0 when the target column is empty', () => {
    const { result, moveCardMutate } = setup();

    act(() => {
      result.current.handleMoveCardToColumn('c1', 'col-empty');
    });

    expect(moveCardMutate.mock.calls[0][0]).toEqual({
      cardId: 'c1',
      toColumnId: 'col-empty',
      position: 0,
    });
  });

  it('does not count the moved card twice when it already sits in the target column', () => {
    const { result, moveCardMutate } = setup();

    act(() => {
      result.current.handleMoveCardToColumn('c1', 'col-a');
    });

    // col-a holds c1 and c2; without c1 that is one card → append at index 1.
    expect(moveCardMutate.mock.calls[0][0]).toEqual({
      cardId: 'c1',
      toColumnId: 'col-a',
      position: 1,
    });
  });
});
