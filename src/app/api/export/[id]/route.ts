import { NextRequest, NextResponse } from "next/server"
import { existsSync } from "fs"
import { logError, logWarn } from "@/lib/logger"
import { createExportArchiveStream, buildExportLocationWeather } from "@/lib/export-stream"
import { safeMediaPath } from "@/lib/media-security"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: "Kein Datenbankzugang.", code: "no_db_access" }, { status: 503 })
  }

  try {
    const { db } = await import("@/lib/db")

    // ── Load entry ──────────────────────────────────────────────────────
    const { rows: [entry] } = await db.query(
      `SELECT
         e.id, e.journal_id, e.text, e.created_at, e.updated_at, e.starred,
         e.location_name, e.location_lat, e.location_lng,
         e.weather_description, e.weather_temp_celsius, e.weather_icon,
         j.name AS journal_name, j.color AS journal_color
       FROM entries e
       JOIN journals j ON j.id = e.journal_id
       WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [id]
    )

    if (!entry) {
      return NextResponse.json({ error: "Eintrag nicht gefunden", code: "entry_not_found" }, { status: 404 })
    }

    // ── Load media ──────────────────────────────────────────────────────
    const { rows: mediaRows } = await db.query(
      `SELECT type, file_path, thumbnail_path, preview_path, order_index, duration_seconds
       FROM media WHERE entry_id = $1 ORDER BY order_index`,
      [id]
    )

    // ── Load tags ───────────────────────────────────────────────────────
    const { rows: tagRows } = await db.query(
      `SELECT t.name FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = $1`,
      [id]
    )

    // ── Build export JSON ───────────────────────────────────────────────
    const photos = mediaRows
      .filter((m) => m.type === "photo")
      .map((m) => ({
        filename: m.file_path.split("/").pop() ?? m.file_path,
        orderIndex: m.order_index,
      }))
    const videos = mediaRows
      .filter((m) => m.type === "video")
      .map((m) => ({
        filename: m.file_path.split("/").pop() ?? m.file_path,
        orderIndex: m.order_index,
        durationSeconds: m.duration_seconds ?? null,
        // Poster + Loop-Clip mitnehmen wie im Bulk-Export — ohne sie verliert
        // ein Einzel-Export-Roundtrip die generierten Video-Assets dauerhaft.
        thumbnailFilename: m.thumbnail_path ? (m.thumbnail_path.split("/").pop() ?? null) : null,
        previewFilename:   m.preview_path   ? (m.preview_path.split("/").pop()   ?? null) : null,
      }))
    const audios = mediaRows
      .filter((m) => m.type === "audio")
      .map((m) => ({
        filename: m.file_path.split("/").pop() ?? m.file_path,
        orderIndex: m.order_index,
        durationSeconds: m.duration_seconds ?? null,
      }))

    const exportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      journals: [{ id: entry.journal_id, name: entry.journal_name, color: entry.journal_color }],
      entries: [
        {
          id: entry.id,
          journalId: entry.journal_id,
          text: entry.text ?? "",
          createdAt: new Date(entry.created_at).toISOString(),
          updatedAt: new Date(entry.updated_at).toISOString(),
          starred: entry.starred,
          ...buildExportLocationWeather(entry),
          tags: tagRows.map((t) => t.name),
          photos,
          videos,
          audios,
        },
      ],
    }

    // ── Build media file list ───────────────────────────────────────────
    const mediaFiles: Array<{ absPath: string; zipName: string }> = []
    for (const m of mediaRows) {
      const folder = m.type === "photo" ? "photos" : m.type === "video" ? "videos" : "audios"
      let absPath: string
      try {
        absPath = safeMediaPath(process.cwd(), m.file_path)
      } catch {
        logWarn(`[export/${id}]`, `skipping ${m.type} with invalid path: ${m.file_path}`)
        continue
      }
      if (!existsSync(absPath)) {
        logWarn(`[export/${id}]`, `${m.type} file missing on disk, skipping: ${m.file_path}`)
        continue
      }
      // zipName must include entry id so import can restore: <type-folder>/<entryId>/<filename>
      mediaFiles.push({ absPath, zipName: `${folder}/${id}/${m.file_path.split("/").pop()}` })

      // For videos: also stream poster (thumbnail_path) and loop-clip (preview_path)
      // so a restore round-trip doesn't lose the generated assets (same as bulk export).
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
            logWarn(`[export/${id}]`, `skipping video asset with invalid path: ${assetPath}`)
            continue
          }
          if (!existsSync(assetAbs)) {
            logWarn(`[export/${id}]`, `video asset missing on disk, skipping: ${assetPath}`)
            continue
          }
          mediaFiles.push({
            absPath: assetAbs,
            zipName: `${assetFolder}/${id}/${assetPath.split("/").pop()}`,
          })
        }
      }
    }

    // ── Stream ZIP directly — never buffer the whole archive in RAM ─────
    const stream = createExportArchiveStream(
      "entry.json",
      JSON.stringify(exportData, null, 2),
      mediaFiles
    )
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="entry-${id}.zip"`,
        // Content-Length omitted: size is unknown until the archive finalises
        // Journal-Inhalt — darf den HTTP-Cache nie erreichen (W-03).
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    logError("[GET /api/export/[id]] Error:", error)
    return NextResponse.json({ error: "Export fehlgeschlagen", code: "export_failed" }, { status: 500 })
  }
}
