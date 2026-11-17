import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StagedPurchase } from '@/types';

const showToast = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  useAuth: vi.fn(() => ({ activeLocationId: 'loc-1', token: 'test' })),
}));
vi.mock('@/components/ui/toast', () => ({
  useToast: vi.fn(() => ({ showToast })),
}));
vi.mock('@/lib/usePermissions', () => ({
  usePermissions: vi.fn(() => ({ canWrite: true, canCreateBin: true })),
}));
vi.mock('@/features/bins/useBins', () => ({
  useBinList: vi.fn(() => ({ bins: [], isLoading: false })),
  addBin: vi.fn().mockResolvedValue({ id: 'bin-new', name: 'Plumbing Parts' }),
}));
vi.mock('@/lib/terminology', () => ({
  useTerminology: () => ({ Area: 'Area' }),
}));
vi.mock('@/features/areas/AreaPicker', () => ({
  AreaPicker: ({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) => (
    <select aria-label="New bin area" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">No area</option>
      <option value="area-garage">Garage</option>
    </select>
  ),
}));
vi.mock('../useStagedPurchases', () => ({
  useStagedPurchases: vi.fn(() => ({ purchases: [], isLoading: false })),
  sortPurchase: vi.fn().mockResolvedValue({ item: { id: 'i1', bin_id: 'bin-k', bin_name: 'Kitchen Tools', name: 'x' } }),
  bulkSortPurchases: vi.fn().mockResolvedValue({ sorted: 2, bin_name: 'Kitchen Tools' }),
  skipPurchase: vi.fn().mockResolvedValue(undefined),
  bulkSkipPurchases: vi.fn().mockResolvedValue({ skipped: 2 }),
  restorePurchase: vi.fn().mockResolvedValue(undefined),
  addPurchaseFromPhoto: vi.fn().mockResolvedValue({ name: 'Gorilla Wood Glue' }),
  stagedPhotoUrl: (id: string) => `/api/staged-purchases/${id}/photo`,
}));

import { addBin, useBinList } from '@/features/bins/useBins';
import { usePermissions } from '@/lib/usePermissions';
import { ToBeSortedPage } from '../ToBeSortedPage';
import { addPurchaseFromPhoto, skipPurchase, sortPurchase, useStagedPurchases } from '../useStagedPurchases';

function purchase(overrides: Partial<StagedPurchase> = {}): StagedPurchase {
  return {
    id: 'p1',
    location_id: 'loc-1',
    source: 'amazon',
    store: 'Amazon',
    order_ref: '112-1',
    title: 'Victorinox Fibrox Pro 8 Inch Chef’s Knife, Dishwasher Safe',
    name: 'Victorinox Fibrox Pro 8 Inch Chef’s Knife',
    quantity: 1,
    price: 49.94,
    currency: 'USD',
    purchased_at: '2026-10-15',
    product_url: 'https://www.amazon.com/dp/B000638D32',
    image_url: null,
    has_photo: false,
    delivered: true,
    status: 'pending',
    skip_reason: null,
    sorted_bin_id: null,
    sorted_bin_name: null,
    resolved_at: null,
    created_at: '2026-10-15T12:00:00Z',
    suggestions: [
      { bin_id: 'bin-k', bin_name: 'Kitchen Tools', area_name: 'Kitchen', icon: '', color: '', reason: 'match', detail: 'Matches “knife”, “chef”', score: 9, confident: true },
      { bin_id: 'bin-d', bin_name: 'Drawer Misc', area_name: '', icon: '', color: '', reason: 'match', detail: 'Matches “pro”', score: 2, confident: false },
    ],
    ...overrides,
  };
}

function renderPage() {
  return render(<MemoryRouter><ToBeSortedPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useBinList).mockReturnValue({ bins: [], isLoading: false } as unknown as ReturnType<typeof useBinList>);
  vi.mocked(usePermissions).mockReturnValue({ canWrite: true, canCreateBin: true } as ReturnType<typeof usePermissions>);
  vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [], isLoading: false, error: null });
});

describe('ToBeSortedPage', () => {
  it('shows an empty state that explains how things get here', () => {
    renderPage();
    expect(screen.getByText('Nothing to sort')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add by photo/ })).toBeInTheDocument();
  });

  it('shows the purchase with its store, price and suggested bins', () => {
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase()], isLoading: false, error: null });
    renderPage();
    expect(screen.getByText('Victorinox Fibrox Pro 8 Inch Chef’s Knife')).toBeInTheDocument();
    expect(screen.getByText(/Amazon · 10\/15\/2026 · \$49\.94/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Put in Kitchen Tools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Put in Drawer Misc' })).toBeInTheDocument();
    expect(screen.getByText('Matches “knife”, “chef”')).toBeInTheDocument();
  });

  it('one tap on a suggestion sorts it, with undo', async () => {
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase()], isLoading: false, error: null });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Put in Kitchen Tools' }));
    await waitFor(() => expect(sortPurchase).toHaveBeenCalledWith('p1', 'bin-k', undefined));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Put Victorinox Fibrox Pro 8 Inch Chef’s Knife in Kitchen Tools',
      action: expect.objectContaining({ label: 'Undo' }),
    })));
  });

  it('sends an edited name with the sort', async () => {
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase()], isLoading: false, error: null });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByLabelText('Item name');
    fireEvent.change(input, { target: { value: 'Chef knife 8"' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Put in Kitchen Tools' }));
    await waitFor(() => expect(sortPurchase).toHaveBeenCalledWith('p1', 'bin-k', 'Chef knife 8"'));
  });

  it('skips', async () => {
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase()], isLoading: false, error: null });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));
    await waitFor(() => expect(skipPurchase).toHaveBeenCalledWith('p1'));
  });

  it('flags orders that have not arrived yet', () => {
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase({ delivered: false })], isLoading: false, error: null });
    renderPage();
    expect(screen.getByText('On the way')).toBeInTheDocument();
  });

  it('offers "Choose a bin…" when there are no suggestions', () => {
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase({ suggestions: [] })], isLoading: false, error: null });
    renderPage();
    expect(screen.getByRole('button', { name: 'Choose a bin…' })).toBeInTheDocument();
  });

  it('creates a new bin from the picker and puts the item in it', async () => {
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase({ suggestions: [] })], isLoading: false, error: null });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a bin…' }));
    fireEvent.change(screen.getByPlaceholderText('Search bins or name a new one...'), { target: { value: '  Plumbing Parts ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bin “Plumbing Parts”' }));
    await waitFor(() => expect(addBin).toHaveBeenCalledWith({ name: 'Plumbing Parts', locationId: 'loc-1', areaId: null }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Put here' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Put here' }));
    await waitFor(() => expect(sortPurchase).toHaveBeenCalledWith('p1', 'bin-new', undefined));
  });

  it('puts a new bin in the chosen area', async () => {
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase({ suggestions: [] })], isLoading: false, error: null });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a bin…' }));
    expect(screen.queryByLabelText('New bin area')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search bins or name a new one...'), { target: { value: 'Plumbing Parts' } });
    fireEvent.change(screen.getByLabelText('New bin area'), { target: { value: 'area-garage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create bin “Plumbing Parts”' }));
    await waitFor(() => expect(addBin).toHaveBeenCalledWith({ name: 'Plumbing Parts', locationId: 'loc-1', areaId: 'area-garage' }));
  });

  it('does not offer to create a bin that already exists', () => {
    vi.mocked(useBinList).mockReturnValue({ bins: [{ id: 'bin-k', name: 'Kitchen Tools', area_name: '' }], isLoading: false } as unknown as ReturnType<typeof useBinList>);
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase({ suggestions: [] })], isLoading: false, error: null });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a bin…' }));
    fireEvent.change(screen.getByPlaceholderText('Search bins or name a new one...'), { target: { value: 'kitchen tools' } });
    expect(screen.queryByRole('button', { name: /Create bin/ })).not.toBeInTheDocument();
  });

  it('only offers to create bins to people who can', () => {
    vi.mocked(usePermissions).mockReturnValue({ canWrite: true, canCreateBin: false } as ReturnType<typeof usePermissions>);
    vi.mocked(useStagedPurchases).mockReturnValue({ purchases: [purchase({ suggestions: [] })], isLoading: false, error: null });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a bin…' }));
    fireEvent.change(screen.getByPlaceholderText('Search bins...'), { target: { value: 'Plumbing Parts' } });
    expect(screen.queryByRole('button', { name: /Create bin/ })).not.toBeInTheDocument();
  });

  it('adds an in-store purchase from a photo', async () => {
    const { container } = renderPage();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'glue.jpg', { type: 'image/jpeg' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(addPurchaseFromPhoto).toHaveBeenCalledWith('loc-1', file));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Added Gorilla Wood Glue' })));
  });

  it('shows where sorted things went, with undo', () => {
    vi.mocked(useStagedPurchases).mockReturnValue({
      purchases: [purchase({ status: 'sorted', sorted_bin_id: 'bin-k', sorted_bin_name: 'Kitchen Tools' })],
      isLoading: false,
      error: null,
    });
    renderPage();
    expect(screen.getByText('In Kitchen Tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Undo/ })).toBeInTheDocument();
  });
});
