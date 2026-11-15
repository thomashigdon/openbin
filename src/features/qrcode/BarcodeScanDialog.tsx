import { Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { haptic } from '@/lib/utils';
import { Html5QrcodePlugin } from './Html5QrcodePlugin';

/** UPC-A, UPC-E, EAN-8, EAN-13 and GTIN-14 are all 8–14 digits. Mirrors the server's normalizeBarcode. */
export function normalizeBarcode(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  return /^\d{8,14}$/.test(digits) ? digits : null;
}

interface BarcodeScanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  /** Called once with the digits of the first product barcode read (or typed). */
  onDetected: (code: string) => void;
}

export function BarcodeScanDialog({ open, onOpenChange, title = 'Scan Barcode', description, onDetected }: BarcodeScanDialogProps) {
  const [manualCode, setManualCode] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (open) {
      setManualCode('');
      setError('');
      setDone(false);
    }
  }, [open]);

  const handleScan = useCallback((text: string) => {
    if (done) return;
    const code = normalizeBarcode(text);
    if (!code) {
      setError('That isn’t a product barcode. Try the UPC/EAN code on the package.');
      return;
    }
    haptic();
    setDone(true);
    onDetected(code);
  }, [done, onDetected]);

  function handleManual() {
    const code = normalizeBarcode(manualCode);
    if (!code) {
      setError('Enter the 8–14 digits under the barcode.');
      return;
    }
    setDone(true);
    onDetected(code);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <Card className="overflow-hidden">
          <CardContent className="py-5">
            {open && (
              <Html5QrcodePlugin
                formats="any"
                containerId="html5-barcode-scanner"
                paused={done}
                onScanSuccess={handleScan}
              />
            )}
            <p className="mt-5 text-center text-[13px] text-[var(--text-tertiary)]">
              Point your camera at the barcode on the package
            </p>
          </CardContent>
        </Card>

        <div className="mt-4">
          <Label className="text-[15px] font-semibold text-[var(--text-primary)] mb-3 block">
            Type It In
          </Label>
          <div className="flex gap-2">
            <Input
              value={manualCode}
              onChange={(e) => {
                setManualCode(e.target.value.replace(/[^0-9\s-]/g, ''));
                setError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleManual();
                }
              }}
              placeholder="e.g. 012345678905"
              inputMode="numeric"
              maxLength={20}
              className="flex-1 font-mono tracking-wider"
              aria-label="Barcode digits"
            />
            <Button onClick={handleManual} disabled={!manualCode.trim()} className="rounded-[var(--radius-md)] shrink-0">
              <Search className="h-4 w-4 mr-1.5" />
              Use
            </Button>
          </div>
          {error && <p className="mt-2 text-[13px] text-[var(--destructive)]">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
