import './html5qrcode-overrides.css';
import type { Html5Qrcode } from 'html5-qrcode';
import { useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '@/lib/utils';

interface Html5QrcodePluginProps {
  paused?: boolean;
  onScanSuccess: (decodedText: string) => void;
  /** `qr` reads QR codes only (bin labels). `any` also reads product barcodes (UPC/EAN). */
  formats?: 'qr' | 'any';
  /** DOM id for the camera view; must be unique if two scanners can be mounted at once. */
  containerId?: string;
}

export function Html5QrcodePlugin({ paused, onScanSuccess, formats = 'qr', containerId = 'html5-qrcode-scanner' }: Html5QrcodePluginProps) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    import('html5-qrcode').then(({ Html5Qrcode, Html5QrcodeSupportedFormats: F }) => {
      if (cancelled) return;

      setLoading(false);
      const scanner = new Html5Qrcode(containerId, {
        verbose: false,
        formatsToSupport: formats === 'any'
          ? [F.QR_CODE, F.UPC_A, F.UPC_E, F.EAN_13, F.EAN_8, F.CODE_128]
          : [F.QR_CODE],
        // The browser's native detector reads 1D barcodes far better than the JS fallback.
        useBarCodeDetectorIfSupported: true,
      });
      scannerRef.current = scanner;

      scanner
        .start(
          { facingMode: 'environment' },
          // Barcodes are wide and short; give them a wide box.
          { fps: 10, qrbox: formats === 'any' ? { width: 300, height: 180 } : { width: 250, height: 250 } },
          (decodedText) => {
            onScanSuccess(decodedText);
          },
          () => {},
        )
        .then(() => {
          // Component unmounted while start() was pending — stop now
          if (cancelled && scanner.isScanning) {
            scanner.stop().catch(() => {});
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(getErrorMessage(err, 'Failed to start camera'));
          }
        });
    });

    return () => {
      cancelled = true;
      if (scannerRef.current?.isScanning) {
        scannerRef.current.stop().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, formats]);

  useEffect(() => {
    const scanner = scannerRef.current;
    if (!scanner) return;

    try {
      if (paused && scanner.isScanning) {
        scanner.pause(true);
      } else if (!paused && scanner.getState() === 3) {
        // State 3 = PAUSED in html5-qrcode
        scanner.resume();
      }
    } catch {
      // Scanner may not be fully initialized yet
    }
  }, [paused]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center px-4">
        <p className="text-[15px] font-medium text-[var(--text-primary)]">Failed to start scanner</p>
        <p className="text-[13px] text-[var(--text-tertiary)]">{error}</p>
      </div>
    );
  }

  return (
    <>
      {loading && (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 rounded-full border-2 border-[var(--bg-active)] border-t-[var(--accent)] animate-spin" />
        </div>
      )}
      <div id={containerId} className="w-full" />
    </>
  );
}
