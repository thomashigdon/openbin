import { Camera, Check, ExternalLink, Loader2, Package, PackageCheck, PackagePlus, Pencil, Truck, Undo2, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { BinIconBadge } from '@/components/ui/bin-icon-badge';
import { BinPickerList } from '@/components/ui/bin-picker-list';
import { Button } from '@/components/ui/button';
import { Crossfade } from '@/components/ui/crossfade';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { SkeletonList } from '@/components/ui/skeleton-list';
import { useToast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { AreaPicker } from '@/features/areas/AreaPicker';
import { addBin } from '@/features/bins/useBins';
import { useAuth } from '@/lib/auth';
import { BulkActionBar } from '@/lib/bulk/BulkActionBar';
import { BulkUpdateDialog } from '@/lib/bulk/BulkUpdateDialog';
import { resolveColor } from '@/lib/colorPalette';
import { resolveIcon } from '@/lib/iconMap';
import { useTerminology } from '@/lib/terminology';
import { usePermissions } from '@/lib/usePermissions';
import { cn, formatDate, pluralize, sectionHeader } from '@/lib/utils';
import type { BinSuggestion, StagedPurchase } from '@/types';
import {
  addPurchaseFromPhoto,
  bulkSkipPurchases,
  bulkSortPurchases,
  restorePurchase,
  type StagedStatus,
  skipPurchase,
  sortPurchase,
  stagedPhotoUrl,
  useStagedPurchases,
} from './useStagedPurchases';

const TABS: Array<{ id: StagedStatus; label: string }> = [
  { id: 'pending', label: 'To sort' },
  { id: 'sorted', label: 'Sorted' },
  { id: 'skipped', label: 'Skipped' },
];

function formatPrice(p: StagedPurchase): string | null {
  if (p.price === null) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency || 'USD' }).format(p.price);
  } catch {
    return `$${p.price.toFixed(2)}`;
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function Thumb({ purchase }: { purchase: StagedPurchase }) {
  const [failed, setFailed] = useState(false);
  // Store photos are fetched and cached by the server (the app's CSP only allows same-origin images).
  const src = purchase.has_photo ? stagedPhotoUrl(purchase.id) : null;
  return (
    <div className="h-16 w-16 shrink-0 rounded-[var(--radius-sm)] bg-[var(--bg-input)] overflow-hidden flex items-center justify-center">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain bg-white"
        />
      ) : (
        <Package className="h-6 w-6 text-[var(--text-tertiary)]" />
      )}
    </div>
  );
}

function SuggestionButton({ s, primary, disabled, onClick }: {
  s: BinSuggestion;
  primary: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = resolveIcon(s.icon);
  return (
    <Tooltip content={s.detail}>
      <Button
        type="button"
        size="sm"
        variant={primary ? 'default' : 'outline'}
        disabled={disabled}
        onClick={onClick}
        className="gap-2 max-w-full"
        aria-label={`Put in ${s.bin_name}`}
      >
        {!primary && <BinIconBadge icon={Icon} colorPreset={s.color ? resolveColor(s.color) : undefined} />}
        <span className="truncate">{s.bin_name}</span>
      </Button>
    </Tooltip>
  );
}

function PurchaseCard({ purchase, selected, busy, canWrite, onToggle, onSort, onPick, onSkip, onUndo }: {
  purchase: StagedPurchase;
  selected: boolean;
  busy: boolean;
  canWrite: boolean;
  onToggle: () => void;
  onSort: (binId: string, binName: string, name: string) => void;
  onPick: (name: string) => void;
  onSkip: () => void;
  onUndo: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(purchase.name);
  const pending = purchase.status === 'pending';
  const price = formatPrice(purchase);
  const meta = [
    purchase.store,
    purchase.purchased_at ? formatDate(purchase.purchased_at.length === 10 ? `${purchase.purchased_at}T12:00:00` : purchase.purchased_at) : null,
    price,
    purchase.quantity && purchase.quantity > 1 ? `×${purchase.quantity}` : null,
  ].filter(Boolean);
  const top = purchase.suggestions[0];

  return (
    <div className={cn('flat-card rounded-[var(--radius-md)] p-3 sm:p-4 flex flex-col gap-3', selected && 'ring-2 ring-[var(--accent)]')}>
      <div className="flex gap-3 min-w-0">
        {pending && canWrite && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label={`Select ${purchase.name}`}
            className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)] cursor-pointer"
          />
        )}
        <Thumb purchase={purchase} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditing(false); }}
              aria-label="Item name"
              className="h-9"
            />
          ) : (
            <div className="flex items-start gap-1.5">
              <span className="font-semibold text-[15px] text-[var(--text-primary)] leading-snug break-words">{name}</span>
              {pending && canWrite && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  aria-label="Rename"
                  className="shrink-0 mt-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--text-tertiary)]">
            {meta.length > 0 && <span>{meta.join(' · ')}</span>}
            {pending && !purchase.delivered && (
              <Badge variant="outline" className="gap-1 py-0"><Truck className="h-3 w-3" />On the way</Badge>
            )}
            {purchase.product_url && (
              <a href={purchase.product_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 hover:text-[var(--text-primary)]">
                Listing <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          {purchase.title !== name && (
            <p className="mt-1 text-[12px] text-[var(--text-tertiary)] line-clamp-2">{purchase.title}</p>
          )}
        </div>
      </div>

      {pending && canWrite && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {purchase.suggestions.map((s, i) => (
              <SuggestionButton key={s.bin_id} s={s} primary={i === 0 && s.confident} disabled={busy} onClick={() => onSort(s.bin_id, s.bin_name, name)} />
            ))}
            <Button type="button" size="sm" variant={purchase.suggestions.length ? 'ghost' : 'outline'} disabled={busy} onClick={() => onPick(name)}>
              {purchase.suggestions.length ? 'Other bin…' : 'Choose a bin…'}
            </Button>
            <Tooltip content="Not storing this. Next time you buy it, it's skipped automatically.">
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onSkip} className="gap-1 ml-auto">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                Skip
              </Button>
            </Tooltip>
          </div>
          {top && <p className="text-[12px] text-[var(--text-tertiary)]">{top.detail}</p>}
        </div>
      )}

      {!pending && (
        <div className="flex items-center justify-between gap-2 text-[13px] text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-1.5 min-w-0">
            {purchase.status === 'sorted' ? (
              <><PackageCheck className="h-4 w-4 shrink-0 text-[var(--color-success)]" /><span className="truncate">In {purchase.sorted_bin_name ?? 'a deleted bin'}</span></>
            ) : (
              <><X className="h-4 w-4 shrink-0" />{purchase.skip_reason === 'auto' ? 'Skipped automatically (skipped before)' : purchase.skip_reason === 'cancelled' ? 'Order cancelled' : 'Skipped'}</>
            )}
          </span>
          {canWrite && (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onUndo} className="gap-1 shrink-0">
              <Undo2 className="h-4 w-4" />Undo
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function ToBeSortedPage() {
  const { activeLocationId } = useAuth();
  const { canWrite, canCreateBin } = usePermissions();
  const { showToast } = useToast();
  const t = useTerminology();
  const locationId = activeLocationId ?? null;
  const [tab, setTab] = useState<StagedStatus>('pending');
  const { purchases, isLoading } = useStagedPurchases(locationId, tab);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<{ ids: string[]; name?: string } | null>(null);
  const [pickedBin, setPickedBin] = useState<string | null>(null);
  const [pickerSearch, setPickerSearch] = useState('');
  // Kept between picks: a run of new bins usually goes in the same room.
  const [newBinAreaId, setNewBinAreaId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedIds = useMemo(() => purchases.filter((p) => selected.has(p.id)).map((p) => p.id), [purchases, selected]);
  const deliveredCount = purchases.filter((p) => p.delivered).length;

  function setBusyFor(ids: string[], on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  }

  function clearSelection(ids: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  async function handleSort(p: StagedPurchase, binId: string, binName: string, name: string) {
    setBusyFor([p.id], true);
    try {
      await sortPurchase(p.id, binId, name !== p.name ? name : undefined);
      clearSelection([p.id]);
      showToast({
        message: `Put ${name} in ${binName}`,
        variant: 'success',
        action: { label: 'Undo', onClick: () => void restorePurchase(p.id) },
      });
    } catch (err) {
      showToast({ message: errorMessage(err, 'Could not put it in that bin'), variant: 'error' });
    } finally {
      setBusyFor([p.id], false);
    }
  }

  async function handleSkip(ids: string[]) {
    setBusyFor(ids, true);
    try {
      if (ids.length === 1) await skipPurchase(ids[0]);
      else await bulkSkipPurchases(ids);
      clearSelection(ids);
      showToast({
        message: ids.length === 1 ? 'Skipped' : `Skipped ${pluralize(ids.length, 'purchase')}`,
        action: ids.length === 1 ? { label: 'Undo', onClick: () => void restorePurchase(ids[0]) } : undefined,
      });
    } catch (err) {
      showToast({ message: errorMessage(err, 'Could not skip'), variant: 'error' });
    } finally {
      setBusyFor(ids, false);
    }
  }

  async function handleUndo(p: StagedPurchase) {
    setBusyFor([p.id], true);
    try {
      await restorePurchase(p.id);
      showToast({ message: `${p.name} is back in To sort` });
    } catch (err) {
      showToast({ message: errorMessage(err, 'Could not undo'), variant: 'error' });
    } finally {
      setBusyFor([p.id], false);
    }
  }

  async function handlePickerApply(ids: string[]) {
    if (!pickedBin || !picker) return;
    const only = ids.length === 1 ? purchases.find((p) => p.id === ids[0]) : undefined;
    try {
      if (only) {
        const r = await sortPurchase(only.id, pickedBin, picker.name && picker.name !== only.name ? picker.name : undefined);
        showToast({
          message: `Put ${r.item.name} in ${r.item.bin_name}`,
          variant: 'success',
          action: { label: 'Undo', onClick: () => void restorePurchase(only.id) },
        });
      } else {
        const r = await bulkSortPurchases(ids, pickedBin);
        showToast({ message: `Put ${pluralize(r.sorted, 'item')} in ${r.bin_name}`, variant: 'success' });
      }
      clearSelection(ids);
    } catch (err) {
      showToast({ message: errorMessage(err, 'Could not put that in the bin'), variant: 'error' });
    }
  }

  async function handleCreateBin(name: string): Promise<string> {
    if (!locationId) throw new Error('No location');
    try {
      // No success toast: the new bin shows up selected, and a toast would cover "Put here" on phones.
      const bin = await addBin({ name, locationId, areaId: newBinAreaId });
      return bin.id;
    } catch (err) {
      showToast({ message: errorMessage(err, 'Could not create that bin'), variant: 'error' });
      throw err;
    }
  }

  async function handlePhoto(file: File | undefined) {
    if (!file || !locationId) return;
    setUploading(true);
    try {
      const p = await addPurchaseFromPhoto(locationId, file);
      setTab('pending');
      showToast({ message: `Added ${p.name}`, variant: 'success' });
    } catch (err) {
      showToast({ message: errorMessage(err, 'Could not add that photo'), variant: 'error' });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="page-content-wide pb-24">
      <PageHeader
        title="To Be Sorted"
        actions={
          canWrite && locationId ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => void handlePhoto(e.target.files?.[0])}
              />
              <Button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="gap-2">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                {uploading ? 'Identifying…' : 'Add by photo'}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="flex items-center gap-1 mb-4" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => { setTab(t.id); setSelected(new Set()); }}
            className={cn(
              'px-3 py-1.5 rounded-[var(--radius-sm)] text-[14px] font-medium cursor-pointer',
              tab === t.id ? 'flat-card text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]',
            )}
          >
            {t.label}
          </button>
        ))}
        {tab === 'pending' && canWrite && deliveredCount > 1 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setSelected(selectedIds.length ? new Set() : new Set(purchases.map((p) => p.id)))}
          >
            {selectedIds.length ? 'Clear selection' : 'Select all'}
          </Button>
        )}
      </div>

      <Crossfade
        isLoading={isLoading && purchases.length === 0}
        skeleton={
          <SkeletonList count={4} className="gap-3">
            {() => (
              <div className="flat-card rounded-[var(--radius-md)] p-4 flex gap-3">
                <Skeleton className="h-16 w-16 rounded-[var(--radius-sm)]" />
                <div className="flex-1 flex flex-col gap-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="h-8 w-1/2 mt-2" />
                </div>
              </div>
            )}
          </SkeletonList>
        }
      >
        {purchases.length === 0 ? (
          <EmptyState
            icon={tab === 'pending' ? PackagePlus : PackageCheck}
            variant={tab === 'pending' ? 'positive' : undefined}
            title={tab === 'pending' ? 'Nothing to sort' : tab === 'sorted' ? 'Nothing sorted yet' : 'Nothing skipped'}
            subtitle={tab === 'pending'
              ? 'Online orders show up here automatically. For things you buy in a store, tap “Add by photo”.'
              : undefined}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {purchases.map((p) => (
              <PurchaseCard
                key={p.id}
                purchase={p}
                selected={selected.has(p.id)}
                busy={busy.has(p.id)}
                canWrite={canWrite}
                onToggle={() => setSelected((prev) => {
                  const next = new Set(prev);
                  next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                  return next;
                })}
                onSort={(binId, binName, name) => void handleSort(p, binId, binName, name)}
                onPick={(name) => setPicker({ ids: [p.id], name })}
                onSkip={() => void handleSkip([p.id])}
                onUndo={() => void handleUndo(p)}
              />
            ))}
          </div>
        )}
      </Crossfade>

      {tab === 'pending' && canWrite && selectedIds.length > 0 && (
        <BulkActionBar
          selectedCount={selectedIds.length}
          onClear={() => setSelected(new Set())}
          actions={[
            { id: 'sort', icon: Check, label: 'Put in bin…', group: 'primary', onClick: () => setPicker({ ids: selectedIds }) },
            { id: 'skip', icon: X, label: 'Skip', group: 'primary', onClick: () => void handleSkip(selectedIds) },
          ]}
        />
      )}

      <BulkUpdateDialog
        open={picker !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPicker(null);
            setPickedBin(null);
            setPickerSearch('');
          }
        }}
        title={picker && picker.ids.length > 1 ? `Put ${picker.ids.length} items in a bin` : 'Put in a bin'}
        description={picker?.name}
        selectedIds={picker?.ids ?? []}
        onApply={handlePickerApply}
        applyDisabled={!pickedBin}
        applyLabel="Put here"
        loadingLabel="Saving…"
      >
        <BinPickerList
          selectedBinId={pickedBin}
          onSelect={setPickedBin}
          search={pickerSearch}
          onSearchChange={setPickerSearch}
          paused={picker === null}
          emptyText="No bins yet"
          onCreate={canCreateBin ? handleCreateBin : undefined}
          createFields={
            <div className="space-y-2">
              <span className={sectionHeader}>{t.Area} for the new bin</span>
              <AreaPicker locationId={locationId ?? undefined} value={newBinAreaId} onChange={setNewBinAreaId} />
            </div>
          }
        />
      </BulkUpdateDialog>
    </div>
  );
}
