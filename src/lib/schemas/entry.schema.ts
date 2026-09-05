import { z } from "zod"

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

export const CreateEntrySchema = z.object({
  text:      z.string().max(100_000).default(""),
  journalId: z.string().uuid("journalId muss eine gültige UUID sein"),
  createdAt: z.string().datetime({ message: "createdAt muss ein ISO-8601-Datum sein" }).optional(),
  starred:   z.boolean().default(false),
  tags:      z.array(z.string().trim().max(100)).max(50).default([]),
  photos:    z.array(z.object({
    filePath:      z.string().max(500),
    thumbnailPath: z.string().max(500).optional(),
  })).max(50).default([]),
}).merge(LocationSchema).merge(WeatherSchema)

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
    type:          z.enum(["photo", "video", "audio"]).optional(),
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
  mediaType: z.enum(["photo", "audio", "video", "any"]).optional().nullable(),
  before:    z.string().regex(/^\d{4}-\d{2}$/, "before muss YYYY-MM sein").optional().nullable(),
  // "true" = Einträge tragen zusätzlich Volltext + komplette Medienliste (Lese-Ansicht "An diesem Tag").
  full:      z.enum(["true", "false"]).optional().nullable(),
  page:      z.coerce.number().int().min(1).default(1),
  perPage:   z.coerce.number().int().min(1).max(100).default(25),
})
