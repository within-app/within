import { z } from "zod"

const SyncEntrySchema = z.object({
  id:                   z.string().uuid(),
  journalId:            z.string().uuid(),
  text:                 z.string().max(100_000).default(""),
  createdAt:            z.string().datetime(),
  updatedAt:            z.string().datetime(),
  revisionId:           z.string().uuid(),
  starred:              z.boolean().default(false),
  tags:                 z.array(z.string().trim().max(100)).max(50).default([]),
  locationName:         z.string().max(500).nullable().optional(),
  locationLat:          z.number().min(-90).max(90).nullable().optional(),
  locationLng:          z.number().min(-180).max(180).nullable().optional(),
  weatherDescription:   z.string().max(200).nullable().optional(),
  weatherTempCelsius:   z.number().min(-100).max(100).nullable().optional(),
  weatherIcon:          z.string().max(50).nullable().optional(),
  deletedAt:            z.string().datetime().nullable().optional(),
})

export const UpsertRequestSchema = z.object({
  entries: z.array(SyncEntrySchema).min(1).max(50),
})

export const ChangesQuerySchema = z.object({
  since:     z.string().datetime({ message: "since muss ein ISO-8601-Datum sein" }),
  journalId: z.string().uuid().nullable().optional(),
  cursor:    z.string().max(500).nullable().optional(),
  limit:     z.coerce.number().int().min(1).max(50).default(50),
})
