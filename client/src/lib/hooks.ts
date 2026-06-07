import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiRequest, getApiBase } from './queryClient';
import type { Conversation, Message, AnalyticsOverview, WeeklyData, HourlyData, TodayReport, Settings } from './types';

export function useOverview() {
  return useQuery<AnalyticsOverview>({
    queryKey: ['overview'],
    queryFn: () => apiFetch('/api/analytics/overview'),
    refetchInterval: 15000,
  });
}

export function useConversations(archived = false, search = '') {
  return useQuery<Conversation[]>({
    queryKey: ['conversations', archived, search],
    queryFn: () => apiFetch(`/api/conversations?archived=${archived ? '1' : '0'}${search ? `&search=${encodeURIComponent(search)}` : ''}`),
    refetchInterval: 15000,
  });
}

export function useMessages(phone: string) {
  return useQuery<Message[]>({
    queryKey: ['messages', phone],
    queryFn: () => apiFetch(`/api/conversations/${encodeURIComponent(phone)}/messages`),
    enabled: !!phone,
    refetchInterval: 5000,
  });
}

export function useWeeklyData() {
  return useQuery<WeeklyData[]>({
    queryKey: ['weekly'],
    queryFn: () => apiFetch('/api/analytics/weekly'),
    refetchInterval: 60000,
  });
}

export function useHourlyData() {
  return useQuery<HourlyData[]>({
    queryKey: ['hourly'],
    queryFn: () => apiFetch('/api/analytics/hourly'),
    refetchInterval: 60000,
  });
}

export function useTodayReport() {
  return useQuery<TodayReport[]>({
    queryKey: ['todayReport'],
    queryFn: () => apiFetch('/api/analytics/today-report'),
    refetchInterval: 30000,
  });
}

export function useSettings() {
  return useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings'),
  });
}

export function useSendMessage(phone: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (message: string) =>
      apiRequest('POST', `/api/conversations/${encodeURIComponent(phone)}/send`, { message }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['messages', phone] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useSyncContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('POST', '/api/zapi/sync-contacts', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      apiRequest('POST', '/api/settings', { key, value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

export function useSetPriority(phone: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ priority, priorityLabel }: { priority: string; priorityLabel?: string }) =>
      apiRequest('PATCH', `/api/conversations/${encodeURIComponent(phone)}/priority`, { priority, priorityLabel }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useAutoReply(phone: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ enabled, message }: { enabled: boolean; message: string }) =>
      apiRequest('POST', `/api/conversations/${encodeURIComponent(phone)}/auto-reply`, { enabled, message }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

// SSE hook
export function useSSE(onEvent: (type: string, data: any) => void) {
  const qc = useQueryClient();
  
  const connect = () => {
    const es = new EventSource(`${getApiBase()}/api/events`);
    
    es.addEventListener('message', (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent('message', data);
        qc.invalidateQueries({ queryKey: ['conversations'] });
        qc.invalidateQueries({ queryKey: ['overview'] });
      } catch {}
    });

    es.addEventListener('sync', (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent('sync', data);
        qc.invalidateQueries({ queryKey: ['conversations'] });
      } catch {}
    });

    es.onerror = () => {
      es.close();
      setTimeout(connect, 5000);
    };

    return es;
  };

  return connect;
}
