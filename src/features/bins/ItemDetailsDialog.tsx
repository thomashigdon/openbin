import { Loader2, ScanBarcode, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { BarcodeScanDialog, normalizeBarcode } from '@/features/qrcode/BarcodeScanDialog';
import { formatPrice, itemTotal, toDateInput } from '@/lib/itemValue';
import type { BinItem } from '@/types';
import { updateItemDetails } from './useBins';

interface ItemDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  binId: string;
  item: BinItem;
  onSaved?: (item: BinItem) => void;
}

export function ItemDetailsDialog({ open, onOpenChange, binId, item, onSaved }: ItemDetailsDialogProps) {
  const { showToast } = useToast();
  const [price, setPrice] = useState('');
  const [date, setDate] = useState('');
  const [store, setStore] = useState('');
  const [barcode, setBarcode] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setPrice(item.unit_price != null ? item.unit_price.toFixed(2) : '');
      setDate(toDateInput(item.purchased_at));
      setStore(item.purchased_from ?? '');
      setBarcode(item.barcode ?? '');
      setError('');
      setSaving(false);
    }
  }, [open, item]);

  const parsedPrice = price.trim() === '' ? null : Number(price.replace(/^\$/, ''));
  const priceInvalid = parsedPrice !== null && (!Number.isFinite(parsedPrice) || parsedPrice < 0);
  const barcodeInvalid = barcode.trim() !== '' && !normalizeBarcode(barcode);
  const showTotal = !priceInvalid && parsedPrice !== null && item.quantity != null && item.quantity > 1;

  async function handleSave() {
    if (priceInvalid || barcodeInvalid) return;
    setSaving(true);
    setError('');
    try {
      const saved = await updateItemDetails(binId, item.id, {
        unit_price: parsedPrice,
        // Keep an imported order timestamp unless the date was actually changed.
        purchased_at: date === toDateInput(item.purchased_at) ? (item.purchased_at ?? null) : (date || null),
        purchased_from: store.trim() || null,
        barcode: barcode.trim() ? normalizeBarcode(barcode) : null,
      });
      onSaved?.({ ...item, ...saved });
      onOpenChange(false);
      showToast({ message: 'Item details saved' });
    } catch {
      setError('Failed to save. Please try again.');
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Item Details</DialogTitle>
            <DialogDescription className="break-words">{item.name}</DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
          >
            <div>
              <Label htmlFor="item-price" className="mb-1.5 block">Price (each)</Label>
              <Input
                id="item-price"
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^0-9.$]/g, ''))}
                placeholder="0.00"
                inputMode="decimal"
              />
              {priceInvalid && <p className="mt-1.5 text-[13px] text-[var(--destructive)]">Enter a price like 12.99</p>}
              {showTotal && parsedPrice !== null && (
                <p className="mt-1.5 text-[13px] text-[var(--text-tertiary)]">
                  {item.quantity} × {formatPrice(parsedPrice)} = {formatPrice(itemTotal({ unit_price: parsedPrice, quantity: item.quantity }) ?? 0)}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="item-purchased-at" className="mb-1.5 block">Purchased</Label>
                <Input id="item-purchased-at" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="item-store" className="mb-1.5 block">Store</Label>
                <Input id="item-store" value={store} onChange={(e) => setStore(e.target.value)} placeholder="e.g. Home Depot" maxLength={100} />
              </div>
            </div>

            <div>
              <Label htmlFor="item-barcode" className="mb-1.5 block">Barcode</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="item-barcode"
                    value={barcode}
                    onChange={(e) => setBarcode(e.target.value.replace(/[^0-9\s-]/g, ''))}
                    placeholder="UPC / EAN"
                    inputMode="numeric"
                    maxLength={20}
                    className="font-mono tracking-wider pr-9"
                  />
                  {barcode && (
                    <button
                      type="button"
                      onClick={() => setBarcode('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                      aria-label="Clear barcode"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <Button type="button" variant="outline" onClick={() => setScanOpen(true)} className="shrink-0" aria-label="Scan barcode">
                  <ScanBarcode className="h-4 w-4" />
                </Button>
              </div>
              {barcodeInvalid && <p className="mt-1.5 text-[13px] text-[var(--destructive)]">Barcodes are 8–14 digits</p>}
            </div>

            {error && <p className="text-[13px] text-[var(--destructive)]">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving || priceInvalid || barcodeInvalid}>
                {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <BarcodeScanDialog
        open={scanOpen}
        onOpenChange={setScanOpen}
        title="Scan Item Barcode"
        onDetected={(code) => {
          setBarcode(code);
          setScanOpen(false);
        }}
      />
    </>
  );
}
