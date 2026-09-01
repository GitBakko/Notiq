import { describe, it, expect } from 'vitest';
import { computeColumnOrder } from '../position';

describe('computeColumnOrder', () => {
  const cases: {
    name: string;
    cardIds: string[];
    cardId: string;
    newIndex: number;
    expected: string[];
  }[] = [
    {
      // Bug repro: this is the exact moveCard trace from the task brief
      // (A=0,B=1,C=2,D=3 moving A to index 2). The buggy insert-and-shift
      // implementation produced A and C both at position 2 with a hole at 1;
      // this asserts the whole array is a contiguous permutation instead.
      name: 'moves a card down (moveCard bug repro: no duplicate positions, no holes)',
      cardIds: ['a', 'b', 'c', 'd'],
      cardId: 'a',
      newIndex: 2,
      expected: ['b', 'c', 'a', 'd'],
    },
    {
      name: 'moves a card up',
      cardIds: ['a', 'b', 'c', 'd'],
      cardId: 'd',
      newIndex: 1,
      expected: ['a', 'd', 'b', 'c'],
    },
    {
      name: 'moves a card to the first index',
      cardIds: ['a', 'b', 'c'],
      cardId: 'c',
      newIndex: 0,
      expected: ['c', 'a', 'b'],
    },
    {
      name: 'moves a card to the last index',
      cardIds: ['a', 'b', 'c'],
      cardId: 'a',
      newIndex: 2,
      expected: ['b', 'c', 'a'],
    },
    {
      name: 'is a no-op when the card is already at that index',
      cardIds: ['a', 'b', 'c'],
      cardId: 'b',
      newIndex: 1,
      expected: ['a', 'b', 'c'],
    },
    {
      name: 'inserts a card coming from another column',
      cardIds: ['x', 'y'],
      cardId: 'new',
      newIndex: 1,
      expected: ['x', 'new', 'y'],
    },
    {
      name: 'clamps an index past the end (the 999 sentinel) to an append',
      cardIds: ['a', 'b'],
      cardId: 'a',
      newIndex: 999,
      expected: ['b', 'a'],
    },
    {
      name: 'appends a foreign card when the index is past the end',
      cardIds: ['x', 'y'],
      cardId: 'z',
      newIndex: 999,
      expected: ['x', 'y', 'z'],
    },
    {
      name: 'clamps a negative index to the front',
      cardIds: ['a', 'b'],
      cardId: 'b',
      newIndex: -3,
      expected: ['b', 'a'],
    },
    {
      name: 'inserts into an empty column',
      cardIds: [],
      cardId: 'only',
      newIndex: 4,
      expected: ['only'],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(computeColumnOrder(c.cardIds, c.cardId, c.newIndex)).toEqual(c.expected);
    });
  }

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c'];
    computeColumnOrder(input, 'a', 2);
    expect(input).toEqual(['a', 'b', 'c']);
  });
});
