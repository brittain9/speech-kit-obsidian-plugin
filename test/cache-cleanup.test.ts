import { describe, expect, it, vi } from 'vitest';
import { cleanupActionsCaches, planOrphanCaches } from '../scripts/cleanup-actions-caches.mjs';

describe('Actions cache cleanup', () => {
  it('preserves live branches and open PR merge/head refs while removing closed refs', () => {
    expect(
      planOrphanCaches(
        [{ name: 'main' }, { name: 'feature' }],
        [{ number: 12 }],
        [
          { id: 1, ref: 'refs/heads/main' },
          { id: 2, ref: 'refs/heads/feature' },
          { id: 3, ref: 'refs/pull/12/merge' },
          { id: 4, ref: 'refs/pull/12/head' },
          { id: 5, ref: 'refs/pull/11/merge' },
          { id: 6, ref: 'refs/heads/deleted' },
          { id: 7, ref: 'refs/tags/2026.11.1' },
        ],
      ),
    ).toEqual([5, 6]);
  });

  it('inventories all pages before deleting, including caches beyond the first hundred', () => {
    const runner = vi.fn((_command: string, args: string[]) => {
      if (args.includes('--method')) return '';
      expect(args).toContain('--paginate');
      expect(args).toContain('--slurp');
      if (args.at(-1)?.includes('/branches')) return JSON.stringify([[{ name: 'main' }]]);
      if (args.at(-1)?.includes('/pulls'))
        return JSON.stringify([[{ number: 12 }], [{ number: 13 }]]);
      return JSON.stringify([
        {
          actions_caches: Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            ref: 'refs/pull/12/merge',
          })),
        },
        {
          actions_caches: [
            { id: 101, ref: 'refs/pull/13/head' },
            { id: 102, ref: 'refs/heads/deleted' },
          ],
        },
      ]);
    });
    expect(cleanupActionsCaches('owner/repo', runner)).toEqual([102]);
    expect(runner).toHaveBeenCalledTimes(4);
    expect(runner.mock.calls.at(-1)?.[1]).toEqual([
      'api',
      '--method',
      'DELETE',
      'repos/owner/repo/actions/caches/102',
    ]);
  });

  it.each(['branches', 'pulls', 'actions/caches'])(
    'deletes nothing if the %s inventory fails',
    (inventory) => {
      const runner = vi.fn((_command: string, args: string[]) => {
        if (args.at(-1)?.includes(`/${inventory}`)) throw new Error('Inventory unavailable');
        if (args.at(-1)?.includes('/actions/caches'))
          return JSON.stringify([{ actions_caches: [{ id: 1, ref: 'refs/heads/deleted' }] }]);
        return JSON.stringify([[{ name: 'main' }]]);
      });
      expect(() => cleanupActionsCaches('owner/repo', runner)).toThrow('Inventory unavailable');
      expect(runner.mock.calls.some(([, args]) => args.includes('DELETE'))).toBe(false);
    },
  );

  it('deletes nothing when a later inventory page is malformed', () => {
    const runner = vi.fn((_command: string, args: string[]) => {
      if (args.at(-1)?.includes('/actions/caches'))
        return JSON.stringify([{ actions_caches: [{ id: 1, ref: 'refs/heads/deleted' }] }]);
      if (args.at(-1)?.includes('/branches')) return JSON.stringify([[{ name: 'main' }]]);
      return JSON.stringify([[{ number: 12 }], { message: 'truncated inventory' }]);
    });
    expect(() => cleanupActionsCaches('owner/repo', runner)).toThrow('Incomplete inventory');
    expect(runner.mock.calls.some(([, args]) => args.includes('DELETE'))).toBe(false);
  });

  it('rejects incomplete inventories rather than inferring that refs are orphaned', () => {
    expect(() => planOrphanCaches([], [], [{ id: 1, ref: 'refs/heads/main' }])).toThrow();
    expect(() => planOrphanCaches([{ name: 'main' }], [{}], [])).toThrow();
    expect(() => planOrphanCaches([{ name: 'main' }], [], [{ id: 1 }])).toThrow();
  });
});
