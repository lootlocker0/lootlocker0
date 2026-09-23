import type { InventoryApiError } from "./types";

export type InventoryResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: InventoryApiError };

/**
 * Every `/api/inventory/*` call goes through here. Per
 * docs/API-CONTRACT.md §6b: an ordinary same-origin `fetch` with the default
 * `credentials: "same-origin"` already sends the `ll_inventory` cookie —
 * never `"omit"`. `cache: "no-store"` matches the route's own
 * `Cache-Control: no-store`.
 *
 * Deliberately not a re-export of components/admin/adminApi.ts even though
 * the two files are near-identical: §6b's whole point is that this session
 * shares nothing with the staff one, including at the frontend-code level —
 * a shared helper module would be a strange place to draw that line only in
 * the backend.
 */
export async function inventoryFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<InventoryResult<T>> {
  let res: Response;
  try {
    const isFormData = init?.body instanceof FormData;
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: "INTERNAL", message: "Network error. Check your connection." },
    };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No body (e.g. a 204, or a proxy error page) — fall through to the
    // generic INTERNAL error below rather than throwing.
  }

  if (!res.ok) {
    const parsed = (body as { error?: InventoryApiError } | null)?.error;
    const error: InventoryApiError = parsed ?? {
      code: "INTERNAL",
      message: "Something broke on our end.",
    };
    return { ok: false, status: res.status, error };
  }

  return { ok: true, data: body as T };
}
