import { useEffect, useState } from 'react';
import { compressPhotosForAi } from '@/features/photos/aiPhotoFormData';
import { apiFetch } from '@/lib/api';
import { Events, notify, useRefreshOn } from '@/lib/eventBus';
import { useListData } from '@/lib/useListQuery';
import type { StagedPurchase } from '@/types';

export type StagedStatus = StagedPurchase['status'];

export function useStagedPurchases(locationId: string | null, status: StagedStatus = 'pending') {
  const { data, isLoading, error } = useListData<StagedPurchase>(
    locationId ? `/api/locations/${locationId}/staged-purchases?status=${status}` : null,
    [Events.STAGED_PURCHASES, Events.BINS],
  );
  return { purchases: data, isLoading, error };
}

/** Pending count for the nav badge. */
export function useStagedCount(locationId: string | null) {
  const [count, setCount] = useState(0);
  const refresh = useRefreshOn(Events.STAGED_PURCHASES);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the event-bus counter that triggers a refetch
  useEffect(() => {
    if (!locationId) {
      setCount(0);
      return;
    }
    const controller = new AbortController();
    apiFetch<{ pending: number }>(`/api/locations/${locationId}/staged-purchases/count`, { signal: controller.signal })
      .then((r) => setCount(r.pending))
      .catch(() => {});
    return () => controller.abort();
  }, [locationId, refresh]);
  return count;
}

function changed(binChanged = false) {
  notify(Events.STAGED_PURCHASES);
  if (binChanged) notify(Events.BINS);
}

export async function sortPurchase(id: string, binId: string, name?: string) {
  const res = await apiFetch<{ purchase: StagedPurchase; item: { id: string; bin_id: string; bin_name: string; name: string } }>(
    `/api/staged-purchases/${id}/sort`,
    { method: 'POST', body: name ? { binId, name } : { binId } },
  );
  changed(true);
  return res;
}

export async function bulkSortPurchases(ids: string[], binId: string) {
  const res = await apiFetch<{ sorted: number; bin_name: string }>(
    '/api/staged-purchases/bulk-sort',
    { method: 'POST', body: { ids, binId } },
  );
  changed(true);
  return res;
}

export async function skipPurchase(id: string) {
  await apiFetch(`/api/staged-purchases/${id}/skip`, { method: 'POST' });
  changed();
}

export async function bulkSkipPurchases(ids: string[]) {
  const res = await apiFetch<{ skipped: number }>('/api/staged-purchases/bulk-skip', { method: 'POST', body: { ids } });
  changed();
  return res;
}

export async function restorePurchase(id: string) {
  await apiFetch(`/api/staged-purchases/${id}/restore`, { method: 'POST' });
  changed(true);
}

export async function deletePurchase(id: string) {
  await apiFetch(`/api/staged-purchases/${id}`, { method: 'DELETE' });
  changed();
}

/** In-store purchase: upload a photo; the server's AI names it (or uses `name` if given). */
export async function addPurchaseFromPhoto(locationId: string, file: File, name?: string) {
  const [compressed] = await compressPhotosForAi([file]);
  const form = new FormData();
  form.append('photo', compressed);
  if (name?.trim()) form.append('name', name.trim());
  const res = await apiFetch<{ purchase: StagedPurchase }>(
    `/api/locations/${locationId}/staged-purchases/photo`,
    { method: 'POST', body: form },
  );
  changed();
  return res.purchase;
}

export function stagedPhotoUrl(id: string) {
  return `/api/staged-purchases/${id}/photo`;
}
