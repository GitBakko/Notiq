import { describe, it, expect } from 'vitest';
import { resolveNotification } from '../notificationI18n';

describe('notificationI18n — kanbanBulkMove', () => {
  const args = {
    actorName: 'Alice',
    count: '3',
    boardTitle: 'Sprint 42',
    summary: '2 × Done, 1 × Doing',
  };

  it('resolves the English body and title', () => {
    const { title, body } = resolveNotification(
      'notifications.kanbanBulkMove',
      args,
      'en',
      'FallbackTitle',
      'FallbackBody',
    );
    expect(title).toBe('Cards Moved');
    expect(body).toBe('Alice moved 3 cards on Sprint 42: 2 × Done, 1 × Doing');
  });

  it('resolves the Italian body and title', () => {
    const { title, body } = resolveNotification(
      'notifications.kanbanBulkMove',
      args,
      'it',
      'FallbackTitle',
      'FallbackBody',
    );
    expect(title).toBe('Card Spostate');
    expect(body).toBe('Alice ha spostato 3 card su Sprint 42: 2 × Done, 1 × Doing');
  });

  it('leaves no unresolved {{placeholder}} in either locale', () => {
    for (const locale of ['en', 'it']) {
      const { body } = resolveNotification(
        'notifications.kanbanBulkMove',
        args,
        locale,
        'FallbackTitle',
        'FallbackBody',
      );
      // Guard against a vacuous pass: an unknown key returns fallbackBody,
      // which trivially contains no {{placeholder}}.
      expect(body).not.toBe('FallbackBody');
      expect(body).not.toContain('{{');
    }
  });
});
