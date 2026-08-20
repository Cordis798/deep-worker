export interface ApiError {
  status: number;
  message: string;
  body?: unknown;
}

const REQUEST_TIMEOUT_MS = 10_000;

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...request } = options;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const isFormData = request.body instanceof FormData;
  const headers = isFormData
    ? request.headers
    : { 'Content-Type': 'application/json', ...request.headers };

  try {
    const response = await fetch(path, {
      ...request,
      credentials: 'include',
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw {
        status: response.status,
        message:
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error?: unknown }).error)
            : response.statusText,
        body,
      } satisfies ApiError;
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw { status: 408, message: '请求超时' } satisfies ApiError;
    }
    throw { status: 0, message: '网络连接失败' } satisfies ApiError;
  } finally {
    window.clearTimeout(timer);
  }
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    apiFetch<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, {
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};

export function getErrorMessage(error: unknown, fallback = '操作失败') {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return error instanceof Error ? error.message : fallback;
}
