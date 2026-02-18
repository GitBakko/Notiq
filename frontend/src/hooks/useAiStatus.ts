import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

export function useAiStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ['ai-status'],
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
