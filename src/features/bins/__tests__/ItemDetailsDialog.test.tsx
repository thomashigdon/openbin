import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../useBins', () => ({
  updateItemDetails: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@/features/qrcode/BarcodeScanDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/qrcode/BarcodeScanDialog')>();
  return {
    ...actual,
    BarcodeScanDialog: ({ open, onDetected }: { open: boolean; onDetected: (code: string) => void }) =>
      open ? <button type="button" onClick={() => onDetected('885911425308')}>Fake Scan</button> : null,
  };
});

import { ItemDetailsDialog } from '../ItemDetailsDialog';
import { updateItemDetails } from '../useBins';

const mockUpdate = vi.mocked(updateItemDetails);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdate.mockImplementation(async (_bin, id, details) => ({ id, name: 'Drill', quantity: 2, ...details }));
});

const item = { id: 'i1', name: 'Drill', quantity: 2, unit_price: 99.5, purchased_at: '2026-01-15T10:00:00.000Z', purchased_from: 'Amazon', barcode: null };

function renderDialog(onSaved = vi.fn(), onOpenChange = vi.fn()) {
  render(<ItemDetailsDialog open onOpenChange={onOpenChange} binId="b1" item={item} onSaved={onSaved} />);
  return { onSaved, onOpenChange };
}

describe('ItemDetailsDialog', () => {
  it('shows the current details and the line total', () => {
    renderDialog();
    expect((screen.getByLabelText('Price (each)') as HTMLInputElement).value).toBe('99.50');
    expect((screen.getByLabelText('Purchased') as HTMLInputElement).value).toBe('2026-01-15');
    expect((screen.getByLabelText('Store') as HTMLInputElement).value).toBe('Amazon');
    expect(screen.getByText('2 × $99.50 = $199.00')).toBeTruthy();
  });

  it('saves edits, keeping an untouched order timestamp, and a scanned barcode', async () => {
    const { onSaved, onOpenChange } = renderDialog();
    fireEvent.change(screen.getByLabelText('Price (each)'), { target: { value: '89' } });
    fireEvent.change(screen.getByLabelText('Store'), { target: { value: ' ' } });
    fireEvent.click(screen.getByLabelText('Scan barcode'));
    fireEvent.click(screen.getByText('Fake Scan'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate).toHaveBeenCalledWith('b1', 'i1', {
      unit_price: 89,
      purchased_at: '2026-01-15T10:00:00.000Z',
      purchased_from: null,
      barcode: '885911425308',
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ unit_price: 89, barcode: '885911425308' }));
  });

  it('blocks saving a bad price or barcode', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Price (each)'), { target: { value: '1.2.3' } });
    expect(screen.getByText('Enter a price like 12.99')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Price (each)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Barcode'), { target: { value: '123' } });
    expect(screen.getByText('Barcodes are 8–14 digits')).toBeTruthy();
    expect((screen.getByText('Save').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
