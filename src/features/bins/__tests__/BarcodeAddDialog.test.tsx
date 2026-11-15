import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../useBins', () => ({
  addItemsToBin: vi.fn(),
  lookupBarcode: vi.fn(),
}));

vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@/lib/terminology', () => ({
  useTerminology: () => ({ bin: 'bin', Bin: 'Bin' }),
}));

vi.mock('@/features/qrcode/BarcodeScanDialog', () => ({
  BarcodeScanDialog: ({ open, onDetected }: { open: boolean; onDetected: (code: string) => void }) =>
    open ? <button type="button" onClick={() => onDetected('885911425308')}>Fake Scan</button> : null,
}));

import { BarcodeAddDialog } from '../BarcodeAddDialog';
import { addItemsToBin, lookupBarcode } from '../useBins';

const mockAdd = vi.mocked(addItemsToBin);
const mockLookup = vi.mocked(lookupBarcode);

beforeEach(() => {
  vi.clearAllMocks();
  mockAdd.mockResolvedValue([]);
});

function renderDialog() {
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter>
      <BarcodeAddDialog open onOpenChange={onOpenChange} binId="b1" locationId="loc-1" />
    </MemoryRouter>,
  );
  return { onOpenChange };
}

describe('BarcodeAddDialog', () => {
  it('names the item from the product lookup and adds it with its barcode', async () => {
    mockLookup.mockResolvedValue({
      code: '885911425308',
      product: { name: '20V MAX Cordless Drill', brand: 'DEWALT', image_url: 'https://cdn.example.com/drill.jpg', source: 'upcitemdb' },
      matches: [],
    });
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByText('Fake Scan'));

    const name = await screen.findByLabelText('Item name');
    expect((name as HTMLInputElement).value).toBe('DEWALT 20V MAX Cordless Drill');
    expect(mockLookup).toHaveBeenCalledWith('885911425308', 'loc-1', { lookup: true });
    // The photo comes from our own server, never the product database's CDN.
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/api/barcodes/885911425308/image');

    fireEvent.click(screen.getByText('Add to Bin'));
    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith('b1', [{ name: 'DEWALT 20V MAX Cordless Drill', barcode: '885911425308' }]));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('says where you already have it', async () => {
    mockLookup.mockResolvedValue({
      code: '885911425308',
      product: null,
      matches: [{ id: 'i9', name: 'Drill', quantity: null, bin_id: 'b2', bin_name: 'Garage Shelf', bin_icon: '', bin_color: '' }],
    });
    renderDialog();
    fireEvent.click(screen.getByText('Fake Scan'));

    expect(await screen.findByText('You already have this')).toBeTruthy();
    expect(screen.getByText('Drill in Garage Shelf')).toBeTruthy();
    expect((screen.getByLabelText('Item name') as HTMLInputElement).value).toBe('Drill');
  });

  it('lets you name an unknown product yourself', async () => {
    mockLookup.mockResolvedValue({ code: '885911425308', product: null, matches: [] });
    renderDialog();
    fireEvent.click(screen.getByText('Fake Scan'));

    expect(await screen.findByText(/No product found/)).toBeTruthy();
    const add = screen.getByText('Add to Bin').closest('button') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Mystery gadget' } });
    expect(add.disabled).toBe(false);
  });
});
