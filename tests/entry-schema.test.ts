import { describe, it, expect } from "vitest"
import {
  CreateEntrySchema,
  UpdateEntrySchema,
  EntryQuerySchema,
} from "../src/lib/schemas/entry.schema"

const VALID_UUID = "123e4567-e89b-12d3-a456-426614174000"

describe("CreateEntrySchema", () => {
  it("rejects a non-UUID journalId with the German error message", () => {
    const result = CreateEntrySchema.safeParse({ journalId: "not-a-uuid" })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages).toContain("journalId muss eine gültige UUID sein")
    }
  })

  it("accepts a minimal valid payload and applies all defaults", () => {
    const result = CreateEntrySchema.safeParse({ journalId: VALID_UUID })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.text).toBe("")
      expect(result.data.starred).toBe(false)
      expect(result.data.tags).toEqual([])
      expect(result.data.photos).toEqual([])
    }
  })

  it("accepts a full valid payload", () => {
    const result = CreateEntrySchema.safeParse({
      journalId: VALID_UUID,
      text: "Hello world",
      starred: true,
      tags: ["travel"],
      photos: [{ filePath: "2026/01/photo.jpg", thumbnailPath: "2026/01/thumb.jpg" }],
    })
    expect(result.success).toBe(true)
  })

  it("rejects text exceeding 100 000 characters", () => {
    const result = CreateEntrySchema.safeParse({
      journalId: VALID_UUID,
      text: "x".repeat(100_001),
    })
    expect(result.success).toBe(false)
  })

  it("rejects an invalid createdAt datetime string", () => {
    const result = CreateEntrySchema.safeParse({
      journalId: VALID_UUID,
      createdAt: "not-a-datetime",
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message)
      expect(messages).toContain("createdAt muss ein ISO-8601-Datum sein")
    }
  })
})

describe("UpdateEntrySchema", () => {
  it("rejects when journalId is missing", () => {
    const result = UpdateEntrySchema.safeParse({
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    expect(result.success).toBe(false)
  })

  it("rejects when createdAt is missing (required on update)", () => {
    const result = UpdateEntrySchema.safeParse({ journalId: VALID_UUID })
    expect(result.success).toBe(false)
  })

  it("accepts a valid update payload", () => {
    const result = UpdateEntrySchema.safeParse({
      journalId: VALID_UUID,
      createdAt: "2026-06-15T10:30:00.000Z",
      text: "Updated text",
      starred: false,
      tags: ["journal"],
    })
    expect(result.success).toBe(true)
  })
})

describe("EntryQuerySchema", () => {
  it("rejects an invalid date string that does not match YYYY-MM-DD", () => {
    const result = EntryQuerySchema.safeParse({ date: "2026-13-40" })
    // The regex matches format shape only — calendar-invalid dates (month 13) still pass.
    expect(result.success).toBe(true)
    // A completely malformed string like "not-a-date" must fail.
    const badFormat = EntryQuerySchema.safeParse({ date: "not-a-date" })
    expect(badFormat.success).toBe(false)
    if (!badFormat.success) {
      const messages = badFormat.error.issues.map((i) => i.message)
      expect(messages).toContain("date muss YYYY-MM-DD sein")
    }
  })

  it("accepts a well-formed YYYY-MM-DD date", () => {
    const result = EntryQuerySchema.safeParse({ date: "2026-07-11" })
    expect(result.success).toBe(true)
  })

  it("coerces page and perPage from query-string strings to numbers", () => {
    const result = EntryQuerySchema.safeParse({ page: "3", perPage: "50" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.page).toBe(3)
      expect(result.data.perPage).toBe(50)
    }
  })

  it("applies default page=1 and perPage=25 when omitted", () => {
    const result = EntryQuerySchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.page).toBe(1)
      expect(result.data.perPage).toBe(25)
    }
  })

  it("rejects perPage above 100", () => {
    const result = EntryQuerySchema.safeParse({ perPage: "101" })
    expect(result.success).toBe(false)
  })

  it("rejects page below 1", () => {
    const result = EntryQuerySchema.safeParse({ page: "0" })
    expect(result.success).toBe(false)
  })

  it("rejects an onThisDay value that does not match MM-DD", () => {
    const result = EntryQuerySchema.safeParse({ onThisDay: "2026-07-11" })
    expect(result.success).toBe(false)
  })

  it("accepts a valid onThisDay MM-DD value", () => {
    const result = EntryQuerySchema.safeParse({ onThisDay: "07-11" })
    expect(result.success).toBe(true)
  })
})
