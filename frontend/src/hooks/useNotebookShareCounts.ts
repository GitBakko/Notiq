import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

interface NotebookShareUser {
  userId: string;
  permission: 'READ' | 'WRITE';
  user: { id: string; name: string | null; email: string; avatarUrl?: string | null };
}

interface NotebookShareData {
  id: string;
  _count: { sharedWith: number };
  sharedWith: NotebookShareUser[];
}

export interface NotebookShareInfo {
  count: number;
  users: NotebookShareUser[];
}

export function useNotebookShareCounts() {
  return useQuery({
    queryKey: ['notebook-share-counts'],
    queryFn: async () => {
      const res = await api.get<NotebookShareData[]>('/notebooks');
      const map: Record<string, NotebookShareInfo> = {};
      for (const nb of res.data) {
        if (nb._count?.sharedWith > 0) {
          map[nb.id] = {
            count: nb._count.sharedWith,
            users: nb.sharedWith || [],
          };
        }
      }
      return map;
    },
    staleTime: 60_000,
  });
}
