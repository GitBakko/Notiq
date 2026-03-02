import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';
import { queryKeys } from '../lib/queryKeys';

export function useAiStatus() {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.ai.status,
    queryFn: async () => {
      const res = await api.get<{ enabled: boolean }>('/ai/status');
      return res.data;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: false,
  });

  return {
    isAiEnabled: data?.enabled ?? false,
    isLoading,
  };
}
