import { z } from "zod"
import { safeOriginalName } from "@/lib/upload-security"

const LocationSchema = z.object({
  locationName: z.string().max(500).nullable().optional(),
  locationLat:  z.number().min(-90).max(90).nullable().optional(),
  locationLng:  z.number().min(-180).max(180).nullable().optional(),
})

const WeatherSchema = z.object({
  weatherDescription: z.string().max(200).nullable().optional(),
  weatherTempCelsius: z.number().min(-100).max(100).nullable().optional(),
  weatherIcon:        z.string().max(50).nullable().optional(),
})

// PDF display fields (2026-10-30). The name is display-only, but it must not
// smuggle path separators or control characters into the DB — the upload
// path enforces this via safeOriginalName(), the entry API does the same.
// size_bytes is an INTEGER column: reject what Postgres would reject with a 500.
const PdfOriginalNameSchema = z.string().max(200)
  .refine((n) => safeOriginalName(n) === n, { message: "originalName enthält Pfad- oder Steuerzeichen" })
  .nullable().optional()
const PdfSizeBytesSchema = z.number().int().nonnegative().max(2_147_483_647).nullable().optional()

export const CreateEntrySchema = z.object({
  text:      z.string().max(100_000).default(""),
  timeZone:  z.string().max(100).nullable().optional(),
  journalId: z.string().uuid("journalId muss eine gültige UUID sein"),
  createdAt: z.string().datetime({ message: "createdAt muss ein ISO-8601-Datum sein" }).optional(),
  starred:   z.boolean().default(false),
  tags:      z.array(z.string().trim().max(100)).max(50).default([]),
  photos:    z.array(z.object({
    filePath:      z.string().max(500),
    thumbnailPath: z.string().max(500).optional(),
    type:          z.enum(["photo", "video", "audio", "pdf"]).optional(),
    // PDF display fields, handed through from the upload response when the
    // file went up before the entry existed (autosave path). Same invariant as
    // the upload: only a name safeOriginalName() would return unchanged.
    originalName:  PdfOriginalNameSchema,
    sizeBytes:     PdfSizeBytesSchema,
  })).max(50).default([]),
}).merge(LocationSchema).merge(WeatherSchema)

export const TimeZoneBackfillSchema = z.object({
  items: z.array(z.object({
    id:       z.string().uuid(),
    timeZone: z.string().max(100),
  })).max(5000),
})

export const UpdateEntrySchema = z.object({
  text:             z.string().max(100_000).default(""),
  journalId:        z.string().uuid("journalId muss eine gültige UUID sein"),
  createdAt:        z.string().datetime({ message: "createdAt muss ein ISO-8601-Datum sein" }),
  starred:          z.boolean().default(false),
  tags:             z.array(z.string().trim().max(100)).max(50).default([]),
  photos:           z.array(z.object({
    id:            z.string().uuid().optional(),
    filePath:      z.string().max(500),
    thumbnailPath: z.string().max(500).optional(),
    type:          z.enum(["photo", "video", "audio", "pdf"]).optional(),
    // PDF display fields, handed through from the upload response when the
    // file went up before the entry existed (autosave path). Same invariant as
    // the upload: only a name safeOriginalName() would return unchanged.
    originalName:  PdfOriginalNameSchema,
    sizeBytes:     PdfSizeBytesSchema,
  })).max(50).optional(),
  clientRevisionId: z.string().uuid().optional(),
}).merge(LocationSchema).merge(WeatherSchema)

export const EntryQuerySchema = z.object({
  journalId: z.string().uuid().optional().nullable(),
  date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date muss YYYY-MM-DD sein").optional().nullable(),
  onThisDay: z.string().regex(/^\d{2}-\d{2}$/, "onThisDay muss MM-DD sein").optional().nullable(),
  year:      z.coerce.number().int().min(1900).max(2100).optional().nullable(),
  q:         z.string().max(500).optional().nullable(),
  tags:      z.string().max(1000).optional().nullable(),
  starred:   z.enum(["true", "false"]).optional().nullable(),
  // "any" = Einträge mit Anlage irgendeines Typs — trägt den Sidebar-Eintrag "Medien".
  mediaType: z.enum(["photo", "audio", "video", "pdf", "any"]).optional().nullable(),
  before:    z.string().regex(/^\d{4}-\d{2}$/, "before muss YYYY-MM sein").optional().nullable(),
  // "true" = Einträge tragen zusätzlich Volltext + komplette Medienliste (Lese-Ansicht "An diesem Tag").
  full:      z.enum(["true", "false"]).optional().nullable(),
  page:      z.coerce.number().int().min(1).default(1),
  perPage:   z.coerce.number().int().min(1).max(100).default(25),
})
