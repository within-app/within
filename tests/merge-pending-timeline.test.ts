/**
 * mergePendingIntoDateGroups unit tests.
 *
 * RED on current main: the function doesn't exist yet.
 * GREEN after F3 implementation in src/lib/timeline/merge-pending.ts.
 */
import { describe, it, expect, afterEach } from "vitest"
import { mergePendingIntoDateGroups } from "../src/lib/timeline/merge-pending"
import type { DateGroup } from "../src/types/journal"
import type { QueuedEdit, SyncEntry } from "../src/lib/sync/types"
import { setAppTimeZone, DEFAULT_TIME_ZONE } from "../src/lib/timezone"

const JOURNAL_ID = "10000000-0000-4000-8000-000000000001"

function makeSyncEntry(id: string, createdAt = "2026-07-26T10:00:00.000Z"): SyncEntry {
  return {
    id, journalId: JOURNAL_ID,
    text: `Synthetic entry ${id}`,
    createdAt, updatedAt: createdAt,
    revisionId: "30000000-0000-4000-8000-000000000001",
    starred: false, tags: [],
    locationName: null, locationLat: null, locationLng: null,
    weatherDescription: null, weatherTempCelsius: null, weatherIcon: null,
    deletedAt: null, thumbnailDataUrl: null,
  }
}

function makeQueuedEdit(entryId: string, createdAt = "2026-07-26T10:00:00.000Z"): QueuedEdit {
  return {
    entryId,
    operation: "create",
    payload: makeSyncEntry(entryId, createdAt),
    queuedAt: createdAt,
  }
}

describe("mergePendingIntoDateGroups", () => {
  it("returns server groups unchanged when queue is empty", () => {
    const server: DateGroup[] = [{
      date: "2026-07-26",
      formattedDate: "2026-07-26",
      entries: [{ id: "s1", journalId: JOURNAL_ID, journalColor: "", createdAt: "2026-07-26T10:00:00.000Z", title: "Server", previewText: "", photoCount: 0, hasAudio: false, hasVideo: false, starred: false, tags: [] }],
    }]
    const merged = mergePendingIntoDateGroups(server, [])
    expect(merged).toHaveLength(1)
    expect(merged[0].entries).toHaveLength(1)
  })

  it("adds a pending entry not yet on the server", () => {
    const pendingId = "20000000-0000-4000-8000-000000000099"
    const server: DateGroup[] = []
    const queue: QueuedEdit[] = [makeQueuedEdit(pendingId)]

    const merged = mergePendingIntoDateGroups(server, queue)
    expect(merged).toHaveLength(1)
    expect(merged[0].entries).toHaveLength(1)
    expect(merged[0].entries[0].id).toBe(pendingId)
    expect(merged[0].entries[0].pending).toBe(true)
  })

  it("does NOT duplicate an entry already present in server groups", () => {
    const serverId = "20000000-0000-4000-8000-000000000001"
    const server: DateGroup[] = [{
      date: "2026-07-26",
      formattedDate: "2026-07-26",
      entries: [{ id: serverId, journalId: JOURNAL_ID, journalColor: "", createdAt: "2026-07-26T10:00:00.000Z", title: "Existing", previewText: "", photoCount: 0, hasAudio: false, hasVideo: false, starred: false, tags: [] }],
    }]
    const queue: QueuedEdit[] = [makeQueuedEdit(serverId)]

    const merged = mergePendingIntoDateGroups(server, queue)
    const totalEntries = merged.reduce((n, g) => n + g.entries.length, 0)
    expect(totalEntries).toBe(1)
  })

  it("ersetzt einen server-bekannten Eintrag mit gequeutem Update durch die lokale Version (B04)", () => {
    // Bis B04 wurden gequeute UPDATES zu server-bekannten IDs übersprungen —
    // die Timeline zeigte den ALTEN Servertext ohne Pending-Kennzeichnung und
    // las sich wie ein verlorener Edit.
    const serverId = "20000000-0000-4000-8000-000000000001"
    const server: DateGroup[] = [{
      date: "2026-07-26",
      formattedDate: "2026-07-26",
      entries: [{ id: serverId, journalId: JOURNAL_ID, journalColor: "#123456", createdAt: "2026-07-26T10:00:00.000Z", title: "Alter Servertext", previewText: "Alter Servertext", thumbnail: "data:image/webp;base64,QUJD", photoCount: 2, hasAudio: false, hasVideo: false, starred: false, tags: [] }],
    }]
    const edit = makeQueuedEdit(serverId)
    edit.operation = "update"
    edit.payload!.text = "Neuer lokaler Text"

    const merged = mergePendingIntoDateGroups(server, [edit])
    const totalEntries = merged.reduce((n, g) => n + g.entries.length, 0)
    expect(totalEntries).toBe(1)

    const entry = merged[0].entries[0]
    expect(entry.pending).toBe(true)
    expect(entry.title).toBe("Neuer lokaler Text")
    // UI-only-Felder, die das Sync-Protokoll nicht kennt, bleiben vom Server.
    expect(entry.journalColor).toBe("#123456")
    expect(entry.thumbnail).toBe("data:image/webp;base64,QUJD")
    expect(entry.photoCount).toBe(2)
  })

  it("merges pending entry into existing date group", () => {
    const serverId = "20000000-0000-4000-8000-000000000001"
    const pendingId = "20000000-0000-4000-8000-000000000099"
    const server: DateGroup[] = [{
      date: "2026-07-26",
      formattedDate: "2026-07-26",
      entries: [{ id: serverId, journalId: JOURNAL_ID, journalColor: "", createdAt: "2026-07-26T08:00:00.000Z", title: "Server", previewText: "", photoCount: 0, hasAudio: false, hasVideo: false, starred: false, tags: [] }],
    }]
    const queue: QueuedEdit[] = [makeQueuedEdit(pendingId, "2026-07-26T10:00:00.000Z")]

    const merged = mergePendingIntoDateGroups(server, queue)
    expect(merged).toHaveLength(1)
    expect(merged[0].entries).toHaveLength(2)
    // Pending entry has the marker
    const pending = merged[0].entries.find((e) => e.id === pendingId)
    expect(pending?.pending).toBe(true)
    // Server entry has no marker
    const serverEntry = merged[0].entries.find((e) => e.id === serverId)
    expect(serverEntry?.pending).toBeFalsy()
  })

  it("creates a new date group for a pending entry on a different day", () => {
    const serverId = "20000000-0000-4000-8000-000000000001"
    const pendingId = "20000000-0000-4000-8000-000000000099"
    const server: DateGroup[] = [{
      date: "2026-07-25",
      formattedDate: "2026-07-25",
      entries: [{ id: serverId, journalId: JOURNAL_ID, journalColor: "", createdAt: "2026-07-25T10:00:00.000Z", title: "Server", previewText: "", photoCount: 0, hasAudio: false, hasVideo: false, starred: false, tags: [] }],
    }]
    const queue: QueuedEdit[] = [makeQueuedEdit(pendingId, "2026-07-26T10:00:00.000Z")]

    const merged = mergePendingIntoDateGroups(server, queue)
    expect(merged).toHaveLength(2)
    // Newest-first ordering
    expect(merged[0].date).toBe("2026-07-26")
    expect(merged[1].date).toBe("2026-07-25")
  })

  it("skips delete operations from the queue", () => {
    const deleteId = "20000000-0000-4000-8000-000000000099"
    const server: DateGroup[] = []
    const queue: QueuedEdit[] = [{
      entryId: deleteId,
      operation: "delete",
      payload: null,
      queuedAt: "2026-07-26T10:00:00.000Z",
    }]

    const merged = mergePendingIntoDateGroups(server, queue)
    expect(merged).toHaveLength(0)
  })

  describe("Rechenbeispiel Zeitzone P2 — pending-Eintrag folgt der App-Zone", () => {
    afterEach(() => setAppTimeZone(DEFAULT_TIME_ZONE))

    it("ein Abendeintrag in UTC−5 landet in der Gruppe des Vortages", () => {
      setAppTimeZone("Etc/GMT+5")
      const pendingId = "20000000-0000-4000-8000-000000000099"
      // 4. September 20:00 Ortszeit → gespeichert 2026-09-05T01:00Z
      const queue: QueuedEdit[] = [makeQueuedEdit(pendingId, "2026-09-05T01:00:00.000Z")]

      const merged = mergePendingIntoDateGroups([], queue)
      expect(merged).toHaveLength(1)
      expect(merged[0].date).toBe("2026-09-04")
    })

    it("in UTC landet derselbe Zeitpunkt in der Gruppe des nächsten Tages", () => {
      const pendingId = "20000000-0000-4000-8000-000000000099"
      const queue: QueuedEdit[] = [makeQueuedEdit(pendingId, "2026-09-05T01:00:00.000Z")]

      const merged = mergePendingIntoDateGroups([], queue)
      expect(merged).toHaveLength(1)
      expect(merged[0].date).toBe("2026-09-05")
    })
  })
})
