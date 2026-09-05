import { NextRequest, NextResponse } from "next/server"
import { existsSync } from "fs"
import { logError, logWarn } from "@/lib/logger"
import { createExportArchiveStream, buildExportLocationWeather } from "@/lib/export-stream"
import { safeMediaPath } from "@/lib/media-security"
import { dateKey } from "@/lib/timezone"

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const journalId = searchParams.get("journalId") || null

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "Kein Datenbankzugang. Export nur auf dem Server mit DATABASE_URL möglich.", code: "export_no_db" }, { status: 503 })
  }

  try {
    const { db } = await import("@/lib/db")

    // ── Load journals ───────────────────────────────────────────────────
    const { rows: journalRows } = await db.query(
      `SELECT id, name, color FROM journals
       WHERE ($1::uuid IS NULL OR id = $1::uuid)
       ORDER BY name`,
      [journalId]
    )

    // ── Load all entries ────────────────────────────────────────────────
    const { rows: entryRows } = await db.query(
      `SELECT
         e.id, e.journal_id, e.text, e.created_at, e.updated_at, e.starred,
         e.location_name, e.location_lat, e.location_lng,
         e.weather_description, e.weather_temp_celsius, e.weather_icon
       FROM entries e
       WHERE e.deleted_at IS NULL
         AND ($1::uuid IS NULL OR e.journal_id = $1::uuid)
       ORDER BY e.created_at DESC`,
      [journalId]
    )

    // ── Load all media ──────────────────────────────────────────────────
    const entryIds = entryRows.map((r) => r.id)
    let mediaRows: Array<{
      id: string; entry_id: string; type: string;
      file_path: string; thumbnail_path: string | null; preview_path: string | null;
      order_index: number; duration_seconds: number | null
    }> = []
    if (entryIds.length > 0) {
      const { rows } = await db.query(
        `SELECT id, entry_id, type, file_path, thumbnail_path, preview_path, order_index, duration_seconds
         FROM media
         WHERE entry_id = ANY($1::uuid[])
         ORDER BY entry_id, order_index`,
        [entryIds]
      )
      mediaRows = rows
    }

    // ── Load all tags ───────────────────────────────────────────────────
    let tagRows: Array<{ entry_id: string; name: string }> = []
    if (entryIds.length > 0) {
      const { rows } = await db.query(
        `SELECT et.entry_id, t.name
         FROM entry_tags et
         JOIN tags t ON t.id = et.tag_id
         WHERE et.entry_id = ANY($1::uuid[])`,
        [entryIds]
      )
      tagRows = rows
    }

    // ── Build lookup maps ───────────────────────────────────────────────
    const mediaByEntry = new Map<string, typeof mediaRows>()
    for (const m of mediaRows) {
      if (!mediaByEntry.has(m.entry_id)) mediaByEntry.set(m.entry_id, [])
      mediaByEntry.get(m.entry_id)!.push(m)
    }

    const tagsByEntry = new Map<string, string[]>()
    for (const t of tagRows) {
      if (!tagsByEntry.has(t.entry_id)) tagsByEntry.set(t.entry_id, [])
      tagsByEntry.get(t.entry_id)!.push(t.name)
    }

    // ── Build export JSON ───────────────────────────────────────────────
    const exportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      journals: journalRows.map((j) => ({ id: j.id, name: j.name, color: j.color })),
      entries: entryRows.map((e) => {
        const entryMedia = mediaByEntry.get(e.id) ?? []
        const photos = entryMedia
          .filter((m) => m.type === "photo")
          .map((m) => ({
            filename: m.file_path.split("/").pop() ?? m.file_path,
            orderIndex: m.order_index,
          }))
        const videos = entryMedia
          .filter((m) => m.type === "video")
          .map((m) => ({
            filename: m.file_path.split("/").pop() ?? m.file_path,
            orderIndex: m.order_index,
            durationSeconds: m.duration_seconds ?? null,
            thumbnailFilename: m.thumbnail_path ? (m.thumbnail_path.split("/").pop() ?? null) : null,
            previewFilename:   m.preview_path   ? (m.preview_path.split("/").pop()   ?? null) : null,
          }))
        const audios = entryMedia
          .filter((m) => m.type === "audio")
          .map((m) => ({
            filename: m.file_path.split("/").pop() ?? m.file_path,
            orderIndex: m.order_index,
            durationSeconds: m.duration_seconds ?? null,
          }))
        return {
          id: e.id,
          journalId: e.journal_id,
          text: e.text ?? "",
          createdAt: new Date(e.created_at).toISOString(),
          updatedAt: new Date(e.updated_at).toISOString(),
          starred: e.starred,
          ...buildExportLocationWeather(e),
          tags: tagsByEntry.get(e.id) ?? [],
          photos,
          videos,
          audios,
        }
      }),
    }

    // ── Build media file list ───────────────────────────────────────────
    const mediaFiles: Array<{ absPath: string; zipName: string }> = []
    for (const e of entryRows) {
      const entryMedia = mediaByEntry.get(e.id) ?? []
      for (const m of entryMedia) {
        const folder = m.type === "photo" ? "photos" : m.type === "video" ? "videos" : "audios"
        let absPath: string
        try {
          absPath = safeMediaPath(process.cwd(), m.file_path)
        } catch {
          logWarn("[export]", `skipping ${m.type} with invalid path: ${m.file_path}`)
          continue
        }
        if (!existsSync(absPath)) {
          logWarn("[export]", `${m.type} file missing on disk, skipping: ${m.file_path}`)
          continue
        }
        mediaFiles.push({ absPath, zipName: `${folder}/${e.id}/${m.file_path.split("/").pop()}` })

        // For videos: also stream poster (thumbnail_path) and loop-clip (preview_path)
        // so a restore round-trip doesn't lose the generated assets.
        if (m.type === "video") {
          for (const [assetPath, assetFolder] of [
            [m.thumbnail_path, "video-thumbnails"],
            [m.preview_path,   "video-previews"  ],
          ] as [string | null, string][]) {
            if (!assetPath) continue
            let assetAbs: string
            try {
              assetAbs = safeMediaPath(process.cwd(), assetPath)
            } catch {
              logWarn("[export]", `skipping video asset with invalid path: ${assetPath}`)
              continue
            }
            if (!existsSync(assetAbs)) {
              logWarn("[export]", `video asset missing on disk, skipping: ${assetPath}`)
              continue
            }
            mediaFiles.push({
              absPath: assetAbs,
              zipName: `${assetFolder}/${e.id}/${assetPath.split("/").pop()}`,
            })
          }
        }
      }
    }

    // ── Stream ZIP directly — never buffer the whole archive in RAM ─────
    // createExportArchiveStream pipes archiver into a Web ReadableStream so
    // the ZIP bytes are written to the response as they are produced.
    // This prevents OOM on GB-sized journals on the Pi 4.
    const dateStr = dateKey(new Date())
    const stream = createExportArchiveStream(
      "export.json",
      JSON.stringify(exportData, null, 2),
      mediaFiles
    )
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="export-${dateStr}.zip"`,
        // Content-Length omitted: size is unknown until the archive finalises
        // Kompletter Journal-Inhalt — darf den HTTP-Cache nie erreichen (W-03).
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    logError("[GET /api/export] Error:", error)
    return NextResponse.json({ error: "Export fehlgeschlagen", code: "export_failed" }, { status: 500 })
  }
}
