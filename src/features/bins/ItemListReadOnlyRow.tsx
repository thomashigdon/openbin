import { itemDetailSummary } from '@/lib/itemValue';
import { cn } from '@/lib/utils';
import type { BinItem } from '@/types';
import { QTY_COL_WIDTH, ROW_BASE } from './itemListLayout';

export function ItemListReadOnlyRow({ item }: { item: BinItem }) {
  const detail = itemDetailSummary(item);
  return (
    <div className={ROW_BASE}>
      <span className="flex-1 min-w-0 text-[15px] text-[var(--text-primary)] leading-relaxed">
        {item.name}
        {detail && <span className="block text-[12px] text-[var(--text-tertiary)] tabular-nums truncate">{detail}</span>}
      </span>
      {item.quantity != null && (
        <span className={cn(QTY_COL_WIDTH, 'text-right text-[15px] text-[var(--text-primary)] leading-relaxed tabular-nums')}>
          {item.quantity}
        </span>
      )}
    </div>
  );
}
