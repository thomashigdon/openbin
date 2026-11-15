import { useState } from 'react';
import { cn } from '@/lib/utils';

/** The looked-up product's photo, served by our own API (hidden if it can't be fetched). */
export function BarcodeProductImage({ code, className }: { code: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={`/api/barcodes/${encodeURIComponent(code)}/image`}
      alt=""
      onError={() => setFailed(true)}
      className={cn('object-contain rounded-[var(--radius-sm)] bg-white', className)}
    />
  );
}
