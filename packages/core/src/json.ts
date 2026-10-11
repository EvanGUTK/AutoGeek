import { z } from 'zod';

/** Any value that survives `JSON.stringify` / `JSON.parse` unchanged. */
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

/** A JSON object (never an array or primitive). */
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;
