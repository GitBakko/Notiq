import api from '../../lib/api';

export interface SearchResult {
  id: string;
  title: string;
  notebookId: string;
  notebookName: string;
  updatedAt: string;
  isPinned: boolean;
  titleHighlight: string;
  contentHighlight: string;
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  page: number;
  limit: number;
}

export const searchNotes = async (
  query: string,
  page: number = 1,
  limit: number = 10,
  notebookId?: string
): Promise<SearchResponse> => {
  const params = new URLSearchParams();
  params.append('q', query);
  params.append('page', String(page));
  params.append('limit', String(limit));
  if (notebookId) params.append('notebookId', notebookId);

  const res = await api.get<SearchResponse>(`/search?${params.toString()}`);
  return res.data;
};
