import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

// i18n: return the key verbatim so we can query by it
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import CardContextMenu from '../CardContextMenu';
import type { KanbanBoard, KanbanCard } from '../../types';

const card = {
  id: 'card-1', title: 'Card 1', dueDate: null, priority: null, columnId: 'col-1',
} as unknown as KanbanCard;

const board = {
  id: 'board-1', ownerId: 'user-1',
  owner: { id: 'user-1', name: 'Owner', email: 'o@x.com', color: null, avatarUrl: null },
  shares: [],
  columns: [{ id: 'col-1', title: 'Todo', position: 0, cards: [] }],
} as unknown as KanbanBoard;

// Harness mirrors KanbanBoardPage: onClose unmounts the menu (setContextMenu(null)).
function Harness({ onDelete }: { onDelete: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <CardContextMenu
      card={card}
      board={board}
      position={{ x: 10, y: 10 }}
      currentColumnId="col-1"
      onClose={() => setOpen(false)}
      onMoveToColumn={vi.fn()}
      onAssign={vi.fn()}
      onSetPriority={vi.fn()}
      onSetDueDate={vi.fn()}
      onLinkNote={vi.fn()}
      onDuplicate={vi.fn()}
      onDelete={onDelete}
    />
  );
}

describe('CardContextMenu — right-click delete', () => {
  it('calls onDelete when the confirm dialog is confirmed (mousedown must not unmount the menu first)', async () => {
    const onDelete = vi.fn();
    render(<Harness onDelete={onDelete} />);

    // Let the setTimeout(0) outside-click listener register
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

    // Open the delete confirmation
    fireEvent.click(screen.getByText('kanban.card.contextMenu.delete'));
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

    const confirmBtn = screen.getByText('Confirm');
    // A real click is mousedown THEN click. The regression: the menu's outside-click
    // handler fired on mousedown (the confirm button lives in a separate portal, outside
    // menuRef), unmounting menu+dialog before the click's onConfirm could run.
    fireEvent.mouseDown(confirmBtn);
    fireEvent.click(confirmBtn);

    expect(onDelete).toHaveBeenCalledWith('card-1');
  });
});
