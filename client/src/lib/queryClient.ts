import { QueryClient } from '@tanstack/react-query';

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export function getApiBase(): string {
  return API_BASE;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10000,
      refetchOnWindowFocus: false,
    },
  },
});

export async function apiRequest(
  method: string,
  path: string,
  body?: any
): Promise<Response> {
  const url = `${getApiBase()}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`${method} ${path} failed: ${res.status} - ${error}`);
  }
  return res;
}

export async function apiFetch<T>(path: string): Promise<T> {
  const res = await apiRequest('GET', path);
  return res.json();
}
