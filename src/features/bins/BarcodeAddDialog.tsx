import { ArrowRight, Loader2, PackageSearch, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { BarcodeScanDialog } from '@/features/qrcode/BarcodeScanDialog';
import { useTerminology } from '@/lib/terminology';
import type { BarcodeLookupResult, BarcodeProduct } from '@/types';
import { BarcodeProductImage } from './BarcodeProductImage';
import { addItemsToBin, lookupBarcode } from './useBins';

interface BarcodeAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  binId: string;
  locationId: string;
}

type Step = 'scan' | 'lookup' | 'confirm' | 'saving';

/** "DEWALT 20V Drill" — brand first, unless the product name already says it. */
function productName(p: BarcodeProduct): string {
  if (!p.brand || p.name.toLowerCase().includes(p.brand.toLowerCase())) return p.name;
  return `${p.brand} ${p.name}`;
}

/** Scan a product barcode, name it from the lookup, and add it to this bin tagged with the code. */
export function BarcodeAddDialog({ open, onOpenChange, binId, locationId }: BarcodeAddDialogProps) {
  const t = useTerminology();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [step, setStep] = useState<Step>('scan');
  const [result, setResult] = useState<BarcodeLookupResult | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setStep('scan');
      setResult(null);
      setName('');
      setError('');
    }
  }, [open]);

  async function handleDetected(code: string) {
    setStep('lookup');
    try {
      const res = await lookupBarcode(code, locationId, { lookup: true });
      setResult(res);
      setName(res.product ? productName(res.product) : res.matches[0]?.name ?? '');
    } catch {
      setResult({ code, product: null, matches: [] });
      setError('Couldn’t look up that barcode. You can still name it yourself.');
    }
    setStep('confirm');
  }

  async function handleAdd() {
    if (!result || !name.trim()) return;
    setStep('saving');
    try {
      await addItemsToBin(binId, [{ name: name.trim(), barcode: result.code }]);
      showToast({ message: `Added ${name.trim()}` });
      onOpenChange(false);
    } catch {
      setError('Failed to add the item. Please try again.');
      setStep('confirm');
    }
  }

  const elsewhere = result?.matches.filter((m) => m.bin_id !== binId) ?? [];
  const here = result?.matches.some((m) => m.bin_id === binId) ?? false;

  if (step === 'scan') {
    return (
      <BarcodeScanDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Add by Barcode"
        description={`Scan an item's barcode to add it to this ${t.bin}.`}
        onDetected={handleDetected}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => step !== 'saving' && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add by Barcode</DialogTitle>
          <DialogDescription className="font-mono tracking-wider">{result?.code}</DialogDescription>
        </DialogHeader>

        {step === 'lookup' ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[14px] text-[var(--text-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Looking up product…
          </div>
        ) : (
          <form
            className="space-y-4 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              void handleAdd();
            }}
          >
            {result?.product?.image_url && <BarcodeProductImage code={result.code} className="mx-auto h-32 w-32" />}
            {!result?.product && !error && result?.matches.length === 0 && (
              <div className="flex items-start gap-2.5 text-[13px] text-[var(--text-secondary)]">
                <PackageSearch className="h-4 w-4 shrink-0 mt-0.5 text-[var(--text-tertiary)]" />
                No product found for this barcode. Name it yourself and scans will find it next time.
              </div>
            )}

            <div>
              <Label htmlFor="barcode-item-name" className="mb-1.5 block">Item name</Label>
              <Input
                id="barcode-item-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What is it?"
                autoFocus
                disabled={step === 'saving'}
              />
            </div>

            {(here || elsewhere.length > 0) && (
              <div className="rounded-[var(--radius-sm)] bg-[var(--bg-hover)] px-3 py-2.5 text-[13px] text-[var(--text-secondary)] space-y-1.5">
                <p className="font-medium text-[var(--text-primary)]">You already have this</p>
                {here && <p>It’s already in this {t.bin}.</p>}
                {elsewhere.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      navigate(`/bin/${m.bin_id}`);
                    }}
                    className="flex w-full items-center gap-1.5 text-left text-[var(--accent)] hover:underline"
                  >
                    <span className="truncate">{m.name}{m.quantity ? ` (×${m.quantity})` : ''} in {m.bin_name}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                  </button>
                ))}
              </div>
            )}

            {error && <p className="text-[13px] text-[var(--destructive)]">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setStep('scan')} disabled={step === 'saving'}>
                <RotateCcw className="h-4 w-4 mr-1.5" />
                Scan Another
              </Button>
              <Button type="submit" disabled={!name.trim() || step === 'saving'}>
                {step === 'saving' && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Add to {t.Bin}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
