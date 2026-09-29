import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// i18n: return the key verbatim so we can query by accessible name
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

import KanbanColumn from '../KanbanColumn';
import BoardCard from '../BoardCard';
import type { KanbanColumn as KanbanColumnType, KanbanCard as KanbanCardType } from '../../types';
import type { LocalKanbanBoard } from '../../../../lib/db';

const card = {
  id: 'c1',
  title: 'Card One',
  position: 0,
  columnId: 'col-1',
  commentCount: 0,
  description: null,
  assignee: null,
  assigneeId: null,
  dueDate: null,
  priority: null,
  noteId: null,
} as unknown as KanbanCardType;

const column = {
  id: 'col-1',
  title: 'Todo',
  position: 0,
  isCompleted: false,
  boardId: 'b1',
  cards: [card],
} as unknown as KanbanColumnType;

const board = {
  id: 'b1',
  title: 'My Board',
  ownership: 'owned',
  columnCount: 1,
  cardCount: 0,
  description: null,
  coverImage: null,
  avatarUrl: null,
  shareCount: 0,
  updatedAt: new Date().toISOString(),
} as unknown as LocalKanbanBoard;

describe('kanban a11y — icon-only buttons have accessible names', () => {
  it('KanbanColumn labels the drag handle and the column menu', () => {
    render(
      <KanbanColumn
        column={column}
        boardId="b1"
        onCardSelect={vi.fn()}
        onRenameColumn={vi.fn()}
        onDeleteColumn={vi.fn()}
        onAddCard={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'kanban.a11y.dragColumn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'kanban.a11y.columnMenu' })).toBeInTheDocument();
  });

  it('KanbanCard labels its drag handle', () => {
    render(
      <KanbanColumn
        column={column}
        boardId="b1"
        onCardSelect={vi.fn()}
        onRenameColumn={vi.fn()}
        onDeleteColumn={vi.fn()}
        onAddCard={vi.fn()}
      />
    );

    // The handle is a <div>; dnd-kit's {...attributes} already gives it role="button".
    expect(screen.getByRole('button', { name: 'kanban.a11y.dragCard' })).toBeInTheDocument();
  });

  it('BoardCard labels its context-menu button', () => {
    render(<BoardCard board={board} onSelect={vi.fn()} onShare={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'kanban.a11y.boardCardMenu' })).toBeInTheDocument();
  });
});

describe('kanban a11y — cards are operable from the keyboard', () => {
  it('KanbanCard body opens the card on Enter', () => {
    const onCardSelect = vi.fn();
    render(
      <KanbanColumn
        column={column}
        boardId="b1"
        onCardSelect={onCardSelect}
        onRenameColumn={vi.fn()}
        onDeleteColumn={vi.fn()}
        onAddCard={vi.fn()}
      />
    );

    const body = screen.getByRole('button', { name: 'Card One' });
    fireEvent.keyDown(body, { key: 'Enter' });

    expect(onCardSelect).toHaveBeenCalledWith('c1');
  });

  it('BoardCard opens the board on Space', () => {
    const onSelect = vi.fn();
    render(<BoardCard board={board} onSelect={onSelect} onShare={vi.fn()} onDelete={vi.fn()} />);

    const root = screen.getByRole('button', { name: /My Board/ });
    fireEvent.keyDown(root, { key: ' ' });

    expect(onSelect).toHaveBeenCalledWith('b1');
  });
});

describe('kanban a11y — no nested interactive controls in the card body', () => {
  it('keeps the move-to-column button outside the role="button" card body', () => {
    const otherColumn = { ...column, id: 'col-2', title: 'Done', cards: [] } as unknown as KanbanColumnType;
    const onCardSelect = vi.fn();
    render(
      <KanbanColumn
        column={column}
        boardId="b1"
        onCardSelect={onCardSelect}
        onRenameColumn={vi.fn()}
        onDeleteColumn={vi.fn()}
        onAddCard={vi.fn()}
        allColumns={[column, otherColumn]}
        onMoveCardToColumn={vi.fn()}
      />
    );

    // The body's accessible name is the title only, not "Card One kanban.card.moveToColumn"
    const body = screen.getByRole('button', { name: 'Card One' });
    const moveBtn = screen.getByRole('button', { name: 'kanban.card.moveToColumn' });
    expect(body.contains(moveBtn)).toBe(false);

    // Enter on the move button must not open the card
    fireEvent.keyDown(moveBtn, { key: 'Enter' });
    expect(onCardSelect).not.toHaveBeenCalled();
  });
});
