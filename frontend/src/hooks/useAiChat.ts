import { useState, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

export interface AiMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  operation?: string;
  createdAt?: string;
  isStreaming?: boolean;
}

interface StreamEvent {
  type: 'token' | 'done' | 'error';
  content: string;
}

export function useAiChat(noteId: string | undefined) {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  // Load history from server
  const { isLoading: isLoadingHistory } = useQuery({
    queryKey: ['ai-history', noteId],
    queryFn: async () => {
      if (!noteId) return [];
      const res = await api.get<AiMessage[]>(`/ai/history/${noteId}`);
      setMessages(res.data);
      return res.data;
    },
    enabled: !!noteId,
    staleTime: 30_000,
  });

  const sendMessage = useCallback(async (
    message: string,
    operation: string,
    targetLanguage?: string
  ) => {
    if (!noteId || isStreaming) return;

    setError(null);
    setIsStreaming(true);

    // Add user message immediately
    const userMsg: AiMessage = { role: 'user', content: message, operation };
    setMessages(prev => [...prev, userMsg]);

    // Add placeholder for assistant response
    const assistantMsg: AiMessage = { role: 'assistant', content: '', isStreaming: true };
    setMessages(prev => [...prev, assistantMsg]);

    try {
      abortRef.current = new AbortController();

      const token = localStorage.getItem('auth-storage');
      let authToken = '';
      if (token) {
        try {
          const parsed = JSON.parse(token);
          authToken = parsed?.state?.token || '';
        } catch {
          // ignore
        }
      }

      const response = await fetch(`${api.defaults.baseURL}/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ noteId, message, operation, targetLanguage }),
        signal: abortRef.current.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to connect to AI service');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event: StreamEvent = JSON.parse(line.slice(6));

            if (event.type === 'token') {
              fullText += event.content;
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: fullText };
                }
                return updated;
              });
            } else if (event.type === 'done') {
              setMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: event.content, isStreaming: false };
                }
                return updated;
              });
            } else if (event.type === 'error') {
              setError(event.content);
              setMessages(prev => prev.filter(m => !m.isStreaming));
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(err.message || 'Failed to get AI response');
        setMessages(prev => prev.filter(m => !m.isStreaming));
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [noteId, isStreaming]);

  const clearHistory = useCallback(async () => {
    if (!noteId) return;
    await api.delete(`/ai/history/${noteId}`);
    setMessages([]);
    queryClient.invalidateQueries({ queryKey: ['ai-history', noteId] });
  }, [noteId, queryClient]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    messages,
    isStreaming,
    isLoadingHistory,
    error,
    sendMessage,
    clearHistory,
    stopStreaming,
  };
}
