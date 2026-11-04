/**
 * Day-One-Import vollständig, gegen echtes Postgres und echtes Dateisystem:
 * Vorschaubild und Loop-Clip für Videos, Sprachmemos, Geräteabgleich nach dem
 * Import, keine Kappung der Warnungen.
 *
 * ffmpeg ist gemockt (auf dem Entwicklungsrechner nicht installiert); das echte
 * Vorschaubild ist per Lauf gegen den Dev-Stack im Container belegt.
 * Needs a running Docker daemon. Synthetic data only.
 */

import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from "vitest"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { tmpdir } from "os"
import { NextRequest } from "next/server"
import { zipSync, strToU8 } from "fflate"
import { randomUUID } from "crypto"
import sharp from "sharp"

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })
vi.mock("@/lib/request-guard", () => ({ guardApiRequest: async () => null }))

const ffmpeg = vi.hoisted(() => ({
  extractPoster: vi.fn(),
  generateLoopClip: vi.fn(),
  probeDuration: vi.fn(),
  probeMediaStreams: vi.fn(),
}))
vi.mock("@/lib/video-thumbnail", () => ffmpeg)

const SCHEMA = readFileSync(join(__dirname, "../src/lib/db/schema.sql"), "utf-8")
const BYTES = new Uint8Array(64).fill(0x41)
const MINIMAL_PDF = strToU8("%PDF-1.4\n%%EOF\n")

const hex = () => randomUUID().replace(/-/g, "").toUpperCase()
const dashed = (h: string) =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toLowerCase()
const dayOneEntry = (over: object = {}) => ({ uuid: hex(), text: "synthetisch", creationDate: "2019-02-01T10:00:00Z", ...over })

describe("Day-One-Import vollständig (echtes Postgres)", () => {
  let container: StartedPostgreSqlContainer
  let client: Client
  let journalId: string
  let mediaRoot: string

  const post = async (body: Uint8Array) => {
    const { POST } = await import("@/app/api/import/route")
    return POST(new NextRequest(new URL(`/api/import?journalId=${journalId}`, "http://localhost:4000"), {
      method: "POST", headers: { "Content-Type": "application/zip" }, body: Buffer.from(body),
    }))
  }
  const importDayOne = async (entries: object[], files: Record<string, Uint8Array> = {}) => {
    const res = await post(zipSync({ "J.json": strToU8(JSON.stringify({ entries })), ...files }))
    expect(res.status).toBe(200)
    return res.json()
  }
  const importV1 = async (entries: object[], files: Record<string, Uint8Array> = {}) => {
    const res = await post(zipSync({
      "export.json": strToU8(JSON.stringify({ version: "1.0", journals: [{ id: journalId, name: "T" }], entries })),
      ...files,
    }))
    expect(res.status).toBe(200)
    return res.json()
  }
  const v1Entry = (over: object = {}) => ({
    id: randomUUID(), journalId, text: "x",
    createdAt: "2019-02-01T10:00:00.000Z", updatedAt: "2019-02-01T10:00:00.000Z", ...over,
  })
  const mediaRows = async () => (await client.query(
    `SELECT id, type, file_path, thumbnail_path, preview_path, order_index, duration_seconds FROM media ORDER BY type, order_index`
  )).rows
  const datasetId = async () =>
    (await client.query(`SELECT value FROM app_settings WHERE key='dataset_id'`)).rows[0]?.value as string | undefined
  /** Spy, der nur die Rotation zählt; der Rest geht an die echte Datenbank. */
  const countRotations = async () => {
    const { db } = await import("@/lib/db")
    return vi.spyOn(db, "query")
  }
  const rotationCalls = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO app_settings")).length
  /** Verbindungsaufbau scheitert ab dem n-ten Aufruf, wie bei einem erschöpften Pool. */
  const failConnectFrom = async (n: number) => {
    const { db } = await import("@/lib/db")
    const real = db.connect.bind(db) as (cb?: unknown) => unknown
    let calls = 0
    // Pool.query() holt sich seine Verbindung selbst per Callback, das bleibt unberührt.
    return vi.spyOn(db, "connect").mockImplementation(((cb?: unknown) =>
      cb ? real(cb)
        : ++calls >= n ? Promise.reject(new Error("timeout exceeded when trying to connect")) : real()) as never)
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start()
    vi.stubEnv("DATABASE_URL", container.getConnectionUri())
    vi.stubEnv("APP_TIMEZONE", "Europe/Berlin")
    client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    await client.query(SCHEMA)
    process.chdir(mkdtempSync(join(tmpdir(), "within-import-")))
    mediaRoot = join(process.cwd(), "public", "media")
  })
  afterAll(async () => {
    const { db } = await import("@/lib/db")
    await db.end?.()
    await client.end()
    await container.stop()
    vi.unstubAllEnvs()
  })
  beforeEach(async () => {
    vi.restoreAllMocks()
    ffmpeg.extractPoster.mockReset().mockImplementation(async (_video: string, out: string) => {
      writeFileSync(out, "synthetic-poster")
      return out
    })
    ffmpeg.generateLoopClip.mockReset()
    ffmpeg.probeDuration.mockReset().mockResolvedValue(42)
    ffmpeg.probeMediaStreams.mockReset().mockResolvedValue("valid")
    await client.query("DELETE FROM entries")
    await client.query("DELETE FROM journals")
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('dataset_id', 'alt', NOW())
       ON CONFLICT (key) DO UPDATE SET value = 'alt'`
    )
    const { rows: [j] } = await client.query(`INSERT INTO journals (name, color) VALUES ('T', '#000000') RETURNING id`)
    journalId = j.id
  })

  describe("Videos", () => {
    it("bekommen Vorschaubild und Loop-Clip, order_index bleibt orderInEntry", async () => {
      const result = await importDayOne(
        [dayOneEntry({ videos: [{ identifier: "A", md5: "video1", type: "mov", orderInEntry: 3, duration: 7.6 }] })],
        { "videos/video1.mov": BYTES }
      )
      expect(result).toMatchObject({ imported: 1, errors: [], warnings: [] })
      const [row] = await mediaRows()
      expect(row.type).toBe("video")
      expect(row.order_index).toBe(3)
      expect(row.duration_seconds).toBe(8)
      const uuid = row.file_path.split("/")[2]
      expect(row.file_path).toBe(`/media/${uuid}/${uuid}-original.mov`)
      expect(row.thumbnail_path).toBe(`/media/${uuid}/${uuid}-poster.webp`)
      expect(readFileSync(join(process.cwd(), "public", row.thumbnail_path), "utf-8")).toBe("synthetic-poster")
      expect(ffmpeg.extractPoster).toHaveBeenCalledWith(
        join(mediaRoot, uuid, `${uuid}-original.mov`),
        join(mediaRoot, uuid, `${uuid}-poster.webp`)
      )
      expect(ffmpeg.generateLoopClip).toHaveBeenCalledTimes(1)
      expect(ffmpeg.generateLoopClip).toHaveBeenCalledWith(
        join(mediaRoot, uuid, `${uuid}-original.mov`),
        join(mediaRoot, uuid, `${uuid}-loop.webp`),
        row.id,
        `/media/${uuid}/${uuid}-loop.webp`
      )
    })

    it("Loop-Clip läuft erst nach dem Commit und bekommt je Video die richtige media-ID", async () => {
      const seen: Promise<number>[] = []
      ffmpeg.generateLoopClip.mockImplementation((_v: string, _o: string, id: string) => {
        seen.push(client.query(`SELECT 1 FROM media WHERE id = $1`, [id]).then((r) => r.rows.length))
      })
      await importDayOne(
        [dayOneEntry({ videos: [
          { identifier: "A", md5: "video1", type: "mov", orderInEntry: 1 },
          { identifier: "B", md5: "video2", type: "mp4", orderInEntry: 0 },
        ] })],
        { "videos/video1.mov": BYTES, "videos/video2.mp4": BYTES }
      )
      expect(await Promise.all(seen)).toEqual([1, 1])
      const rows = await mediaRows()
      expect(rows.map((r) => [r.order_index, r.file_path.split(".").pop()])).toEqual([[0, "mp4"], [1, "mov"]])
      for (const row of rows) {
        const call = ffmpeg.generateLoopClip.mock.calls.find((c) => c[2] === row.id)!
        expect(dirname(call[0] as string)).toBe(join(mediaRoot, row.file_path.split("/")[2]))
      }
    })

    it("Inhalt ungültig: Warnung, kein Vorschaubild-Versuch, keine Zeile, kein Ordner", async () => {
      const ordnerNachher = () =>
        existsSync(mediaRoot) ? readdirSync(mediaRoot).filter((n) => !n.startsWith(".")).sort() : []
      const ordnerVorher = ordnerNachher()
      ffmpeg.probeMediaStreams.mockResolvedValue("invalid")
      const result = await importDayOne(
        [dayOneEntry({ videos: [{ identifier: "A", md5: "video1", type: "mov", orderInEntry: 0 }] })],
        { "videos/video1.mov": BYTES }
      )
      expect(result.imported).toBe(1)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain("videos/video1.mov")
      expect(await mediaRows()).toEqual([])
      expect(ffmpeg.extractPoster).not.toHaveBeenCalled()
      expect(ffmpeg.probeMediaStreams).toHaveBeenCalledWith(expect.stringContaining("video1.mov"), "video")
      expect(ordnerNachher()).toEqual(ordnerVorher)
    })

    it("nicht erlaubte Endung aus dem Export: Warnung, die Datei landet nicht auf der Platte", async () => {
      const result = await importDayOne(
        [dayOneEntry({ videos: [{ identifier: "A", md5: "video1", type: "svg", orderInEntry: 0 }] })],
        { "videos/video1.svg": BYTES }
      )
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain("videos/video1.svg")
      expect(await mediaRows()).toEqual([])
      expect(ffmpeg.probeMediaStreams).not.toHaveBeenCalled()
    })

    it("scheitert das Vorschaubild, bleibt keine angefangene Bilddatei liegen", async () => {
      let teilDatei = ""
      ffmpeg.extractPoster.mockImplementation(async (_video: string, out: string) => {
        teilDatei = out
        writeFileSync(out, "teil")
        return null
      })
      await importDayOne(
        [dayOneEntry({ videos: [{ identifier: "A", md5: "video1", type: "mov", orderInEntry: 0 }] })],
        { "videos/video1.mov": BYTES }
      )
      expect(existsSync(teilDatei)).toBe(false)
    })

    it("ohne Vorschaubild wird das Video trotzdem importiert", async () => {
      ffmpeg.extractPoster.mockResolvedValue(null)
      const result = await importDayOne(
        [dayOneEntry({ videos: [{ identifier: "A", md5: "video1", type: "mov", orderInEntry: 0 }] })],
        { "videos/video1.mov": BYTES }
      )
      expect(result).toMatchObject({ imported: 1, errors: [], warnings: [] })
      const [row] = await mediaRows()
      expect(row.thumbnail_path).toBeNull()
      expect(ffmpeg.generateLoopClip).toHaveBeenCalledTimes(1)
    })

    it("scheitert die Transaktion, bleibt kein Vorschaubild liegen und es startet kein Loop-Clip", async () => {
      const result = await importDayOne(
        // NUL lehnt Postgres in TEXT ab — das scheitert erst nach dem Datei-Schritt, im INSERT.
        [dayOneEntry({ text: "kaputt\u0000", videos: [{ identifier: "A", md5: "video1", type: "mov", orderInEntry: 0 }] })],
        { "videos/video1.mov": BYTES }
      )
      expect(result.imported).toBe(0)
      expect(result.errors).toHaveLength(1)
      const written = ffmpeg.extractPoster.mock.calls[0][1] as string
      expect(existsSync(written)).toBe(false)
      expect(readdirSync(dirname(written))).toEqual([])
      expect(ffmpeg.generateLoopClip).not.toHaveBeenCalled()
    })
  })

  describe("Sprachmemos", () => {
    const memo = (over: object = {}) => ({ identifier: "M", md5: "memo1", format: "aac", orderInEntry: 0, ...over })

    it("format sagt aac, die Datei heißt .m4a: Zeile vom Typ audio, Platzhalter weg", async () => {
      const entry = dayOneEntry({
        text: "Text ![](dayone-moment:/audio/ABC123)",
        audios: [memo({ orderInEntry: 2, duration: 12.6 })],
      })
      const result = await importDayOne([entry], { "audios/memo1.m4a": BYTES })
      expect(result).toMatchObject({ imported: 1, errors: [], warnings: [] })
      const [row] = await mediaRows()
      expect(row).toMatchObject({ type: "audio", thumbnail_path: null, preview_path: null, order_index: 2, duration_seconds: 13 })
      const uuid = row.file_path.split("/")[2]
      expect(row.file_path).toBe(`/media/${uuid}/${uuid}-original.m4a`)
      expect(readFileSync(join(process.cwd(), "public", row.file_path))).toEqual(Buffer.from(BYTES))
      expect(ffmpeg.probeMediaStreams).toHaveBeenCalledWith(expect.stringContaining("memo1.m4a"), "audio")
      expect(ffmpeg.probeDuration).not.toHaveBeenCalled()
      const { rows: [saved] } = await client.query(`SELECT text FROM entries`)
      expect(saved.text).toBe("Text")
    })

    it("sucht .m4a, dann .aac, dann .mp3", async () => {
      await importDayOne([
        dayOneEntry({ audios: [memo({ md5: "nuraac" })] }),
        dayOneEntry({ audios: [memo({ md5: "nurmp3" })] }),
        dayOneEntry({ audios: [memo({ md5: "beide" })] }),
      ], {
        "audios/nuraac.aac": BYTES,
        "audios/nurmp3.mp3": BYTES,
        "audios/beide.m4a": BYTES,
        "audios/beide.aac": BYTES,
      })
      const endings = (await mediaRows()).map((r) => r.file_path.split(".").pop()).sort()
      expect(endings).toEqual(["aac", "m4a", "mp3"])
    })

    it("ohne brauchbare Länge im JSON misst probeDuration", async () => {
      await importDayOne([
        dayOneEntry({ audios: [memo({ md5: "ohne" })] }),
        dayOneEntry({ audios: [memo({ md5: "null", duration: 0 })] }),
        dayOneEntry({ audios: [memo({ md5: "text", duration: "kaputt" })] }),
        dayOneEntry({ audios: [memo({ md5: "riesig", duration: 1e12 })] }),
      ], {
        "audios/ohne.m4a": BYTES, "audios/null.m4a": BYTES, "audios/text.m4a": BYTES, "audios/riesig.m4a": BYTES,
      })
      const rows = await mediaRows()
      expect(rows.map((r) => r.duration_seconds)).toEqual([42, 42, 42, 42])
    })

    it("Inhalt ungültig: Warnung, übersprungen, keine Zeile, kein Ordner", async () => {
      ffmpeg.probeMediaStreams.mockResolvedValue("invalid")
      const entry = dayOneEntry({ audios: [memo()] })
      const before = existsSync(mediaRoot) ? readdirSync(mediaRoot).length : 0
      const result = await importDayOne([entry], { "audios/memo1.m4a": BYTES })
      expect(result.imported).toBe(1)
      expect(result.warnings).toEqual([`${entry.uuid}: Übersprungen, keine Audiodatei: audios/memo1.m4a`])
      expect(await mediaRows()).toEqual([])
      // Das einzige neue Verzeichnis wäre die temporäre Sitzung, und die ist wieder weg.
      expect(readdirSync(mediaRoot).length).toBe(before)
    })

    it("Prüfung nicht möglich (kein ffprobe): wird wie beim Upload trotzdem genommen", async () => {
      ffmpeg.probeMediaStreams.mockResolvedValue("unknown")
      const result = await importDayOne([dayOneEntry({ audios: [memo()] })], { "audios/memo1.m4a": BYTES })
      expect(result.warnings).toEqual([])
      expect(await mediaRows()).toHaveLength(1)
    })

    it("Datei fehlt: Warnung wie bei den anderen Typen, der Eintrag kommt trotzdem", async () => {
      const entry = dayOneEntry({ audios: [memo()] })
      const result = await importDayOne([entry])
      expect(result.imported).toBe(1)
      expect(result.warnings).toEqual([`${entry.uuid}: Datei fehlt im ZIP: audios/memo1.m4a`])
      expect(await mediaRows()).toEqual([])
    })

    it("scheitert die Transaktion, wird die Memo-Datei wieder entfernt", async () => {
      let moved = ""
      ffmpeg.probeDuration.mockImplementation(async (p: string) => { moved = p; return 5 })
      const result = await importDayOne(
        [dayOneEntry({ text: "kaputt\u0000", audios: [memo()] })],
        { "audios/memo1.m4a": BYTES }
      )
      expect(result.errors).toHaveLength(1)
      expect(moved).toMatch(/-original\.m4a$/)
      expect(existsSync(moved)).toBe(false)
    })

    it("Fotos, Videos, PDFs und Memos behalten je ihr orderInEntry", async () => {
      const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#808080" } }).jpeg().toBuffer()
      await importDayOne([dayOneEntry({
        photos: [
          { identifier: "P1", md5: "foto1", type: "jpeg", orderInEntry: 5 },
          { identifier: "P2", md5: "foto2", type: "jpeg", orderInEntry: 1 },
        ],
        videos: [{ identifier: "V1", md5: "video1", type: "mov", orderInEntry: 4 }],
        pdfAttachments: [{ identifier: "D1", md5: "pdf1", type: "pdf", pdfName: "a.pdf", orderInEntry: 3 }],
        audios: [memo({ md5: "memo2", orderInEntry: 2 }), memo({ md5: "memo3", orderInEntry: 0 })],
      })], {
        "photos/foto1.jpeg": jpeg, "photos/foto2.jpeg": jpeg, "videos/video1.mov": BYTES,
        "pdfs/pdf1.pdf": MINIMAL_PDF, "audios/memo2.m4a": BYTES, "audios/memo3.m4a": BYTES,
      })
      const byOrder = (await mediaRows()).sort((a, b) => a.order_index - b.order_index)
      expect(byOrder.map((r) => [r.order_index, r.type])).toEqual([
        [0, "audio"], [1, "photo"], [2, "audio"], [3, "pdf"], [4, "video"], [5, "photo"],
      ])
    })
  })

  describe("Geräteabgleich", () => {
    it("Day One: neue Kennung genau einmal je Request, nicht bei jedem Eintrag", async () => {
      const spy = await countRotations()
      await importDayOne([dayOneEntry(), dayOneEntry(), dayOneEntry()])
      expect(rotationCalls(spy)).toBe(1)
      const id = await datasetId()
      expect(id).not.toBe("alt")
      expect(id).toMatch(/^[0-9a-f-]{36}$/)
    })

    it("Day One: ein erneuter Lauf nach Abbruch stößt den Abgleich an, sonst bekämen Geräte die Einträge nie", async () => {
      const entry = dayOneEntry()
      await importDayOne([entry])
      const danach = await datasetId()
      const again = await importDayOne([entry])
      expect(again).toMatchObject({ imported: 0, skipped: 1 })
      expect(await datasetId()).not.toBe(danach)
    })

    it("Day One: leerer Import und reine Fehler rotieren nicht", async () => {
      const leer = await importDayOne([])
      expect(leer.imported).toBe(0)
      const kaputt = await importDayOne([{ uuid: "nicht-hex", text: "x", creationDate: "2019-02-01T10:00:00Z" }])
      expect(kaputt).toMatchObject({ imported: 0 })
      expect(kaputt.errors).toHaveLength(1)
      expect(await datasetId()).toBe("alt")
    })

    it("eigenes Format: rotiert bei neuen Einträgen und beim Wiederholen", async () => {
      const spy = await countRotations()
      const entry = v1Entry()
      const first = await importV1([entry, v1Entry()])
      expect(first.imported).toBe(2)
      expect(rotationCalls(spy)).toBe(1)
      const danach = await datasetId()
      expect(danach).not.toBe("alt")
      const again = await importV1([entry])
      expect(again).toMatchObject({ imported: 0, skipped: 1 })
      expect(await datasetId()).not.toBe(danach)
    })

    it("Day One: scheitert die Rotation, ist der Import trotzdem gelungen und es gibt eine Warnung", async () => {
      await client.query(`ALTER TABLE app_settings RENAME TO app_settings_weg`)
      try {
        const entry = dayOneEntry()
        const result = await importDayOne([entry])
        expect(result.imported).toBe(1)
        expect(result.errors).toEqual([])
        expect(result.warnings).toHaveLength(1)
        expect(result.warnings[0]).toContain("Geräteabgleich")
        const { rows } = await client.query(`SELECT id FROM entries`)
        expect(rows.map((r) => r.id)).toEqual([dashed(entry.uuid)])
      } finally {
        await client.query(`ALTER TABLE app_settings_weg RENAME TO app_settings`)
      }
    })

    it("eigenes Format: scheitert die Rotation, gibt es ebenfalls nur die Warnung", async () => {
      await client.query(`ALTER TABLE app_settings RENAME TO app_settings_weg`)
      try {
        const result = await importV1([v1Entry()])
        expect(result.imported).toBe(1)
        expect(result.errors).toEqual([])
        expect(result.warnings[0]).toContain("Geräteabgleich")
      } finally {
        await client.query(`ALTER TABLE app_settings_weg RENAME TO app_settings`)
      }
    })

    it("Day One: reißt die Verbindung nach committeten Einträgen ab, wird trotzdem rotiert", async () => {
      const spy = await failConnectFrom(2)
      const result = await importDayOne(
        [dayOneEntry(), dayOneEntry({ audios: [{ identifier: "M", md5: "memo1", format: "aac" }] })],
        { "audios/memo1.m4a": BYTES }
      )
      spy.mockRestore()
      expect(result.imported).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(await datasetId()).not.toBe("alt")
      const moved = ffmpeg.probeDuration.mock.calls[0][0] as string
      expect(existsSync(moved)).toBe(false)
    })

    it("eigenes Format: reißt die Verbindung nach committeten Einträgen ab, wird trotzdem rotiert", async () => {
      const spy = await failConnectFrom(2)
      const result = await importV1([v1Entry(), v1Entry()])
      spy.mockRestore()
      expect(result.imported).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(await datasetId()).not.toBe("alt")
    })
  })

  describe("Alle Warnungen und Fehler", () => {
    it("Day One: nichts wird nach 20 abgeschnitten", async () => {
      const photos = Array.from({ length: 25 }, (_, i) => ({ identifier: `P${i}`, md5: `fehlt${i}`, type: "jpeg" }))
      const kaputt = Array.from({ length: 25 }, (_, i) => ({ uuid: `kaputt-${i}`, text: "x", creationDate: "2019-02-01T10:00:00Z" }))
      const result = await importDayOne([dayOneEntry({ photos }), ...kaputt])
      expect(result.warnings).toHaveLength(25)
      expect(result.errors).toHaveLength(25)
    })

    it("eigenes Format: nichts wird nach 20 abgeschnitten", async () => {
      const photos = Array.from({ length: 25 }, (_, i) => ({ filename: `fehlt${i}.jpg`, orderIndex: i }))
      const kaputt = Array.from({ length: 25 }, () => v1Entry({ id: "keine-uuid" }))
      const result = await importV1([v1Entry({ photos }), ...kaputt])
      expect(result.warnings).toHaveLength(25)
      expect(result.errors).toHaveLength(25)
    })
  })
})
