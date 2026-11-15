/**
 * AI helpers for staged purchases:
 * - identifyPurchasePhoto: name a single newly bought item from a photo (in-store purchases)
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

const PHOTO_PROMPT = `${HARDENING_INSTRUCTION}

You identify a single item someone just bought so it can be filed into a storage bin. The photo shows the product, its packaging, or its label; read brand, model and size from any visible text.

"name" — what the item is, as it would appear in a home inventory: brand + product type + the one detail that tells it apart (size, count, model). 2–8 words, Title Case. Good: "DeWalt 20V Drill Driver", "Gorilla Wood Glue 8 oz", "AA Batteries". Bad: "Item", "Box", "Product".
"quantity" — how many units are visible or stated on the package, only if clear; otherwise omit.
"description" — one short sentence of extra detail (color, size, what it's for), or omit.
If several different products are visible, describe the most prominent one.`;

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
