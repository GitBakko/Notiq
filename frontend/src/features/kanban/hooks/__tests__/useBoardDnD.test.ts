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

  it('advances the explicit position across synchronous calls into the same column (bulk-move loop pattern)', () => {
    const { result, moveCardMutate } = setup();

    // handleMoveCardToColumn is a useCallback memoized on localColumns. A
    // bulk move (KanbanBoardPage.handleBulkMove) calls it N times in one
    // synchronous stretch with no render between iterations, so every call
    // reads the SAME localColumns snapshot — the derived (no-arg) append
    // index would be IDENTICAL for every card in the batch. The caller must
    // instead pass an explicit, per-card position (appendBase + i); this
    // pins that those explicit positions are threaded straight through and
    // do not collapse to a single stale value.
    act(() => {
      result.current.handleMoveCardToColumn('c2', 'col-b', 1);
      result.current.handleMoveCardToColumn('c1', 'col-b', 2);
    });

    expect(moveCardMutate.mock.calls[0][0]).toEqual({
      cardId: 'c2',
      toColumnId: 'col-b',
      position: 1,
    });
    expect(moveCardMutate.mock.calls[1][0]).toEqual({
      cardId: 'c1',
      toColumnId: 'col-b',
      position: 2,
    });
  });
});
