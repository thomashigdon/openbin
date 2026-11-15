import { Download, Printer, Receipt } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Crossfade } from '@/components/ui/crossfade';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useBinList } from '@/features/bins/useBins';
import { useActiveLocation } from '@/features/locations/useLocations';
import { formatPrice, formatPurchaseDate, itemTotal } from '@/lib/itemValue';
import { useTerminology } from '@/lib/terminology';
import { cn } from '@/lib/utils';
import { buildValueReport, valueReportCsv } from './valueReport';

const NUM_COL = 'px-2 sm:px-3 py-1.5 text-right tabular-nums whitespace-nowrap';

function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** What everything is worth, by area and bin. Prints cleanly for an insurance record. */
export function InventoryValuePage() {
  const t = useTerminology();
  const navigate = useNavigate();
  const location = useActiveLocation();
  const { bins, isLoading } = useBinList(undefined, 'name');
  const [params, setParams] = useSearchParams();
  const pricedOnly = params.get('priced') === '1';

  const report = useMemo(() => buildValueReport(bins, { pricedOnly }), [bins, pricedOnly]);
  const unpriced = report.itemCount - report.pricedCount;
  const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const locationName = location?.name ?? '';

  function handleCsv() {
    const date = new Date().toISOString().slice(0, 10);
    const slug = locationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'inventory';
    downloadCsv(`${slug}-inventory-value-${date}.csv`, valueReportCsv(report));
  }

  return (
    <div className="page-content-wide">
      <PageHeader
        title="Inventory Value"
        className="print-hide"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleCsv} disabled={report.areas.length === 0} aria-label="Download CSV">
              <Download className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">CSV</span>
            </Button>
            <Button onClick={() => window.print()} disabled={report.areas.length === 0} aria-label="Print or save as PDF">
              <Printer className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Print / PDF</span>
            </Button>
          </div>
        }
      />

      <div className="print-show mb-4">
        <h1 className="text-[22px] font-semibold">Home Inventory{locationName ? ` — ${locationName}` : ''}</h1>
        <p className="text-[13px]">Prepared {today}</p>
      </div>

      <Crossfade
        isLoading={isLoading && bins.length === 0}
        skeleton={
          <div className="flex flex-col gap-4">
            <Skeleton className="h-20 w-full rounded-[var(--radius-md)]" />
            <Skeleton className="h-64 w-full rounded-[var(--radius-md)]" />
          </div>
        }
      >
        {report.itemCount === 0 ? (
          <EmptyState
            icon={Receipt}
            title="Nothing to value yet"
            subtitle={`Add items to your ${t.bins}, then set prices from each item's "Price & barcode" menu. Purchases put away from To Be Sorted bring their price with them.`}
          />
        ) : (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="flat-card rounded-[var(--radius-md)] px-4 py-3">
                <p className="ui-eyebrow">Total value</p>
                <p className="mt-1 text-[24px] font-semibold tabular-nums text-[var(--text-primary)]">{formatPrice(report.total)}</p>
              </div>
              <div className="flat-card rounded-[var(--radius-md)] px-4 py-3">
                <p className="ui-eyebrow">Items priced</p>
                <p className="mt-1 text-[24px] font-semibold tabular-nums text-[var(--text-primary)]">
                  {report.pricedCount}
                  <span className="text-[15px] font-normal text-[var(--text-tertiary)]"> of {report.itemCount}</span>
                </p>
              </div>
              <div className="flat-card rounded-[var(--radius-md)] px-4 py-3 print-hide col-span-2 sm:col-span-1 flex items-center justify-between gap-3">
                <label htmlFor="priced-only" className="text-[14px] text-[var(--text-secondary)]">Only priced items</label>
                <Switch
                  id="priced-only"
                  checked={pricedOnly}
                  onCheckedChange={(on: boolean) => setParams(on ? { priced: '1' } : {}, { replace: true })}
                />
              </div>
            </div>

            {unpriced > 0 && (
              <p className="print-hide text-[13px] text-[var(--text-tertiary)]">
                {unpriced} {unpriced === 1 ? 'item has' : 'items have'} no price. Open an item's menu in its {t.bin} and choose “Price &amp; barcode” to add one.
              </p>
            )}

            {report.areas.map((area) => (
              <section key={area.name} className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between border-b border-[var(--border-subtle)] pb-1">
                  <h2 className="text-[17px] font-semibold text-[var(--text-primary)]">{area.name}</h2>
                  <span className="text-[15px] font-semibold tabular-nums text-[var(--text-primary)]">{formatPrice(area.total)}</span>
                </div>

                {area.bins.map((bin) => (
                  <div key={bin.id} className="flat-card rounded-[var(--radius-md)] overflow-hidden [break-inside:avoid]">
                    <button
                      type="button"
                      onClick={() => navigate(`/bin/${bin.id}`)}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 bg-[var(--bg-hover)] border-b border-[var(--border-subtle)] text-left"
                    >
                      <span className="font-medium text-[15px] text-[var(--text-primary)] truncate">{bin.name}</span>
                      <span className="text-[14px] tabular-nums text-[var(--text-secondary)]">{formatPrice(bin.total)}</span>
                    </button>
                    <div className="overflow-x-auto">
                      <table className="w-full table-fixed text-[14px]">
                        <thead>
                          <tr className="text-[12px] text-[var(--text-tertiary)]">
                            <th className="pl-3 pr-2 sm:px-3 py-1.5 text-left font-medium">Item</th>
                            <th className={cn(NUM_COL, 'font-medium w-10 sm:w-14')}>Qty</th>
                            <th className={cn(NUM_COL, 'font-medium w-[4.75rem] sm:w-24')}>Each</th>
                            <th className={cn(NUM_COL, 'font-medium w-[5.25rem] sm:w-24')}>Total</th>
                            <th className="px-3 py-1.5 text-left font-medium w-32 hidden sm:table-cell print:table-cell">Purchased</th>
                            <th className="px-3 py-1.5 text-left font-medium w-36 hidden sm:table-cell print:table-cell">Store</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bin.items.map((item) => {
                            const total = itemTotal(item);
                            return (
                              <tr key={item.id} className="border-t border-[var(--border-subtle)] text-[var(--text-primary)]">
                                <td className="pl-3 pr-2 sm:px-3 py-1.5 break-words">{item.name}</td>
                                <td className={NUM_COL}>{item.quantity ?? 1}</td>
                                <td className={NUM_COL}>{item.unit_price != null ? formatPrice(item.unit_price) : '—'}</td>
                                <td className={NUM_COL}>{total != null ? formatPrice(total) : '—'}</td>
                                <td className="px-3 py-1.5 whitespace-nowrap hidden sm:table-cell print:table-cell text-[var(--text-secondary)]">
                                  {formatPurchaseDate(item.purchased_at)}
                                </td>
                                <td className="px-3 py-1.5 truncate hidden sm:table-cell print:table-cell text-[var(--text-secondary)]">{item.purchased_from ?? ''}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </section>
            ))}

            <div className="flex items-baseline justify-between border-t-2 border-[var(--border-flat)] pt-2">
              <span className="text-[17px] font-semibold text-[var(--text-primary)]">Total</span>
              <span className="text-[17px] font-semibold tabular-nums text-[var(--text-primary)]">{formatPrice(report.total)}</span>
            </div>
          </div>
        )}
      </Crossfade>
    </div>
  );
}
