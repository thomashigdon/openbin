/**
 * AI helpers for staged purchases:
 * - identifyPurchasePhoto: name a single newly bought item from a photo (in-store purchases)
 * - extractReceiptItems:   pull line items out of an order-confirmation email from any store
 */
import { generateObject } from 'ai';
import { z } from 'zod';
import { mapSdkError } from './aiErrors.js';
import { HARDENING_INSTRUCTION } from './aiSanitize.js';
import { resolveUserModel } from './aiStreamHandler.js';

const PhotoItemSchema = z.object({
  name: z.string(),
  quantity: z.number().nullable().optional(),
  description: z.string().nullable().optional(),
});

const ReceiptSchema = z.object({
  is_purchase: z.boolean(),
  store: z.string(),
  order_ref: z.string().nullable().optional(),
  status: z.enum(['ordered', 'shipped', 'delivered', 'picked_up', 'in_store', 'other']),
  items: z.array(z.object({
    name: z.string(),
    title: z.string(),
    quantity: z.number().nullable().optional(),
    price: z.number().nullable().optional(),
    product_url: z.string().nullable().optional(),
  })),
});

export type ReceiptExtraction = z.infer<typeof ReceiptSchema>;

const PHOTO_PROMPT = `${HARDENING_INSTRUCTION}

You identify a single item someone just bought so it can be filed into a storage bin. The photo shows the product, its packaging, or its label; read brand, model and size from any visible text.

"name" — what the item is, as it would appear in a home inventory: brand + product type + the one detail that tells it apart (size, count, model). 2–8 words, Title Case. Good: "DeWalt 20V Drill Driver", "Gorilla Wood Glue 8 oz", "AA Batteries". Bad: "Item", "Box", "Product".
"quantity" — how many units are visible or stated on the package, only if clear; otherwise omit.
"description" — one short sentence of extra detail (color, size, what it's for), or omit.
If several different products are visible, describe the most prominent one.`;

const RECEIPT_PROMPT = `${HARDENING_INSTRUCTION}

You read an order confirmation, receipt or shipping email from an online store and list the physical items that were bought, so they can be put away in storage bins later.

"is_purchase" — true only if the email is about an order of physical goods that will be kept around the home (tools, parts, supplies, household goods, electronics, clothing, toys, books). False for marketing, cart reminders, account notices, digital purchases, subscriptions and memberships, services and bill payments, refunds and returns, food and drink (groceries, restaurants, butchers, meal kits), and mail-delivery digests.
"store" — the retailer's name, e.g. "Home Depot".
"order_ref" — the order number if shown.
"status" — "ordered" (confirmation), "shipped", "delivered", "picked_up" (store pickup completed), "in_store" (receipt for an in-person purchase), or "other".
"items" — one entry per product line:
  "title": the product name exactly as written in the email;
  "name": a short inventory name, brand + product type + key detail, 2–8 words, Title Case (e.g. "Gorilla Wood Glue 8 oz");
  "quantity": units ordered if shown; "price": unit price as a number if shown; "product_url": the product's link if it appears in the email.
Leave out shipping, tax, discounts, gift cards, warranties and services. If is_purchase is false, return an empty items list.`;

export interface PhotoIdentification {
  name: string;
  quantity: number | null;
  description: string | null;
}

export async function identifyPurchasePhoto(
  userId: string,
  image: { buffer: Buffer; mimeType: string },
  demo: boolean,
): Promise<PhotoIdentification> {
  const { settings, model } = await resolveUserModel(userId, 'analysis', demo);
  try {
    const result = await generateObject({
      model,
      schema: PhotoItemSchema,
      system: PHOTO_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', image: image.buffer, mediaType: image.mimeType },
          { type: 'text', text: 'Identify this newly bought item.' },
        ],
      }],
      maxOutputTokens: 400,
      temperature: settings.temperature ?? 0.2,
      abortSignal: AbortSignal.timeout((settings.request_timeout ?? 120) * 1000),
    });
    const o = result.object;
    return {
      name: o.name.trim().slice(0, 200),
      quantity: typeof o.quantity === 'number' && o.quantity >= 1 && o.quantity <= 10000 ? Math.floor(o.quantity) : null,
      description: o.description?.trim().slice(0, 300) || null,
    };
  } catch (err) {
    throw mapSdkError(err);
  }
}

export const MAX_RECEIPT_CHARS = 30_000;

export async function extractReceiptItems(
  userId: string,
  email: { from: string; subject: string; text: string },
  demo: boolean,
): Promise<ReceiptExtraction> {
  const { settings, model } = await resolveUserModel(userId, 'structure', demo);
  const body = [
    `From: ${email.from}`,
    `Subject: ${email.subject}`,
    '',
    email.text.slice(0, MAX_RECEIPT_CHARS),
  ].join('\n');
  try {
    const result = await generateObject({
      model,
      schema: ReceiptSchema,
      system: RECEIPT_PROMPT,
      messages: [{ role: 'user', content: `<email>\n${body}\n</email>` }],
      maxOutputTokens: 3000,
      temperature: 0.1,
      abortSignal: AbortSignal.timeout((settings.request_timeout ?? 120) * 1000),
    });
    const o = result.object;
    return {
      ...o,
      items: o.is_purchase ? o.items.filter((i) => i.title.trim() || i.name.trim()).slice(0, 100) : [],
    };
  } catch (err) {
    throw mapSdkError(err);
  }
}
