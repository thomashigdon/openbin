import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type ApiClient, withErrorHandling } from "../api-client.js";
import { resolveBinId } from "../resolve-bin.js";
import { type BinDetail, resolveItemId } from "../resolve-item.js";

interface Item {
  id: string;
  name: string;
  quantity: number | null;
  unit_price: number | null;
  purchased_at: string | null;
  purchased_from: string | null;
  barcode: string | null;
  bin_id: string;
  bin_name: string;
  bin_icon: string;
  bin_color: string;
}

interface ItemListResponse {
  results: Item[];
  count: number;
}

interface AddItemsResponse {
  items: Array<{ id: string; name: string }>;
}

interface BarcodeLookupResponse {
  code: string;
  product: { name: string; brand: string | null; source: string } | null;
  matches: Array<{ id: string; name: string; quantity: number | null; bin_id: string; bin_name: string }>;
}

/** " — $12.99 ea · Amazon · 2026-11-02 · barcode 012345678905", or "" when the item has none. */
function itemDetailText(item: Pick<Item, "unit_price" | "purchased_at" | "purchased_from" | "barcode">): string {
  const parts: string[] = [];
  if (item.unit_price != null) parts.push(`$${item.unit_price.toFixed(2)} ea`);
  if (item.purchased_from) parts.push(item.purchased_from);
  if (item.purchased_at) parts.push(item.purchased_at.slice(0, 10));
  if (item.barcode) parts.push(`barcode ${item.barcode}`);
  return parts.length ? ` — ${parts.join(" · ")}` : "";
}

export function registerItemTools(server: McpServer, api: ApiClient) {
  server.tool(
    "search_items",
    "Search items across all bins in a location. Matches item names, bin names, and exact barcodes. Shows any price, store, purchase date and barcode.",
    {
      location_id: z.string().describe("Location UUID (required)"),
      q: z.string().optional().describe("Search text"),
      sort: z.enum(["alpha", "bin"]).optional().describe("Sort by item name or bin name"),
      limit: z.number().min(1).max(100).optional().describe("Max results (1-100, default 40)"),
      offset: z.number().min(0).optional().describe("Offset for pagination"),
    },
    withErrorHandling(async ({ location_id, q, sort, limit, offset }) => {
      const params = new URLSearchParams({ location_id });
      if (q) params.set("q", q);
      if (sort) params.set("sort", sort);
      if (limit !== undefined) params.set("limit", String(limit));
      if (offset !== undefined) params.set("offset", String(offset));

      const data = await api.get<ItemListResponse>(`/api/items?${params}`);

      if (data.results.length === 0) {
        return { content: [{ type: "text" as const, text: "No items found." }] };
      }

      const lines = data.results.map(
        (item) => `- **${item.name}**${item.quantity ? ` ×${item.quantity}` : ""} [${item.id}] in bin "${item.bin_name}" (bin_id: ${item.bin_id})${itemDetailText(item)}`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${data.count} item(s)${data.results.length < data.count ? ` (showing ${data.results.length})` : ""}:\n\n${lines.join("\n")}`,
          },
        ],
      };
    }),
  );

  server.tool(
    "add_items",
    "Add items to a bin",
    {
      bin_id: z.string().describe("Bin UUID or 6-character short code"),
      items: z.array(z.string()).min(1).describe("Item names to add"),
    },
    withErrorHandling(async ({ bin_id, items }) => {
      bin_id = await resolveBinId(api, bin_id);
      const data = await api.post<AddItemsResponse>(
        `/api/bins/${encodeURIComponent(bin_id)}/items`,
        { items },
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Added ${data.items.length} item(s): ${data.items.map((i) => i.name).join(", ")}`,
          },
        ],
      };
    }),
  );

  server.tool(
    "remove_item",
    "Remove a single item from a bin. Provide item_id or item_name (not both).",
    {
      bin_id: z.string().describe("Bin UUID or 6-character short code"),
      item_id: z.string().optional().describe("Item UUID"),
      item_name: z.string().optional().describe("Item name (case-insensitive match)"),
    },
    withErrorHandling(async ({ bin_id, item_id, item_name }) => {
      bin_id = await resolveBinId(api, bin_id);
      const resolved = await resolveItemId(api, bin_id, item_id, item_name);
      if ("error" in resolved) {
        return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
      }

      await api.del(
        `/api/bins/${encodeURIComponent(bin_id)}/items/${encodeURIComponent(resolved.id)}`,
      );

      return {
        content: [{ type: "text" as const, text: "Item removed successfully." }],
      };
    }),
  );

  server.tool(
    "rename_item",
    "Rename an item within a bin. Provide item_id or item_name (not both).",
    {
      bin_id: z.string().describe("Bin UUID or 6-character short code"),
      item_id: z.string().optional().describe("Item UUID"),
      item_name: z.string().optional().describe("Current item name (case-insensitive match)"),
      name: z.string().describe("New item name"),
    },
    withErrorHandling(async ({ bin_id, item_id, item_name, name }) => {
      bin_id = await resolveBinId(api, bin_id);
      const resolved = await resolveItemId(api, bin_id, item_id, item_name);
      if ("error" in resolved) {
        return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
      }

      const item = await api.put<{ id: string; name: string }>(
        `/api/bins/${encodeURIComponent(bin_id)}/items/${encodeURIComponent(resolved.id)}`,
        { name },
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Item renamed to "${item.name}".`,
          },
        ],
      };
    }),
  );

  server.tool(
    "reorder_items",
    "Reorder items within a bin. Provide item_ids or item_names (not both).",
    {
      bin_id: z.string().describe("Bin UUID or 6-character short code"),
      item_ids: z.array(z.string()).optional().describe("Item UUIDs in the desired order"),
      item_names: z.array(z.string()).optional().describe("Item names in the desired order (resolved to IDs via bin lookup)"),
    },
    withErrorHandling(async ({ bin_id, item_ids, item_names }) => {
      bin_id = await resolveBinId(api, bin_id);
      if (!item_ids && !item_names) {
        return {
          content: [{ type: "text" as const, text: "Provide either 'item_ids' or 'item_names'." }],
          isError: true,
        };
      }

      let resolvedIds = item_ids;
      if (!resolvedIds && item_names) {
        const bin = await api.get<BinDetail>(`/api/bins/${encodeURIComponent(bin_id)}`);
        const ids: string[] = [];
        for (const name of item_names) {
          const matches = bin.items.filter(
            (i) => i.name.toLowerCase() === name.toLowerCase(),
          );
          if (matches.length === 0) {
            return {
              content: [{ type: "text" as const, text: `No item named "${name}" found in this bin.` }],
              isError: true,
            };
          }
          if (matches.length > 1) {
            const list = matches.map((m) => `- ${m.name} [${m.id}]`).join("\n");
            return {
              content: [{ type: "text" as const, text: `Multiple items named "${name}" found. Use item_ids instead:\n${list}` }],
              isError: true,
            };
          }
          ids.push(matches[0].id);
        }
        resolvedIds = ids;
      }

      await api.put(
        `/api/bins/${encodeURIComponent(bin_id)}/items/reorder`,
        { item_ids: resolvedIds },
      );

      return {
        content: [{ type: "text" as const, text: `Items reordered (${resolvedIds!.length} items).` }],
      };
    }),
  );
  server.tool(
    "set_item_details",
    "Set an item's purchase details and/or barcode: price per unit, purchase date, store. Only the fields given change; pass null to clear one. Provide item_id or item_name (not both).",
    {
      bin_id: z.string().describe("Bin UUID or 6-character short code"),
      item_id: z.string().optional().describe("Item UUID"),
      item_name: z.string().optional().describe("Item name (case-insensitive match)"),
      unit_price: z.number().min(0).nullable().optional().describe("Price paid per unit, in dollars"),
      purchased_at: z.string().nullable().optional().describe("Purchase date, YYYY-MM-DD"),
      purchased_from: z.string().nullable().optional().describe("Store or seller, e.g. 'Home Depot'"),
      barcode: z.string().nullable().optional().describe("UPC/EAN digits (8-14)"),
    },
    withErrorHandling(async ({ bin_id, item_id, item_name, ...details }) => {
      bin_id = await resolveBinId(api, bin_id);
      const resolved = await resolveItemId(api, bin_id, item_id, item_name);
      if ("error" in resolved) {
        return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
      }

      const item = await api.patch<Item>(
        `/api/bins/${encodeURIComponent(bin_id)}/items/${encodeURIComponent(resolved.id)}/details`,
        details,
      );

      return {
        content: [{ type: "text" as const, text: `Updated "${item.name}"${itemDetailText(item) || " — no details set"}.` }],
      };
    }),
  );

  server.tool(
    "lookup_barcode",
    "Find which bins hold items with a UPC/EAN barcode, and what product the barcode is (from public product databases).",
    {
      location_id: z.string().describe("Location UUID (required)"),
      barcode: z.string().describe("UPC/EAN digits (8-14)"),
    },
    withErrorHandling(async ({ location_id, barcode }) => {
      const params = new URLSearchParams({ location_id, lookup: "true" });
      const data = await api.get<BarcodeLookupResponse>(`/api/barcodes/${encodeURIComponent(barcode)}?${params}`);

      const product = data.product
        ? `Product: ${data.product.brand ? `${data.product.brand} ` : ""}${data.product.name} (via ${data.product.source})`
        : "Product: not found in the public databases";
      const where = data.matches.length
        ? data.matches.map((m) => `- **${m.name}**${m.quantity ? ` ×${m.quantity}` : ""} [${m.id}] in bin "${m.bin_name}" (bin_id: ${m.bin_id})`).join("\n")
        : "No items in this location have this barcode.";

      return { content: [{ type: "text" as const, text: `Barcode ${data.code}\n${product}\n\n${where}` }] };
    }),
  );
}
