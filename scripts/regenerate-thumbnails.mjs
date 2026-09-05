/**
 * scripts/regenerate-thumbnails.mjs
 * Backfill: regenerate broken thumbnails
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/regenerate-thumbnails.mjs
 *
 * Optional environment variables:
 *   PUBLIC_DIR   Absolute path to the project's public/ directory.
 *                Defaults to <project-root>/public (one level above this script).
 *
 * What it does:
 *   Queries the media table for rows where a dedicated thumbnail exists
 *   (thumbnail_path IS NOT NULL AND thumbnail_path != file_path), then
 *   re-runs the fixed sharp pipeline (.rotate() → .resize() → .webp()) to
 *   overwrite each thumbnail in place. Originals and DB rows are NOT touched.
 *
 * Safety:
 *   - Idempotent: already-upright originals produce a visually identical thumb.
 *   - Dry-run safe: pass --dry-run to list affected rows without writing files.
 *   - Only run against your local public/media after this fix is deployed.
 *     Never run in CI or against committed real data.
 *
 * Deploy note:
 *   This backfill is NOT automatic on redeploy — run it manually once
 *   against your existing local media after the fix is live.
 */

import { readFile } from "fs/promises"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import pg from "pg"
import sharp from "sharp"

const { Pool } = pg

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = join(__dirname, "..")

function resolvePublicDir() {
  return process.env.PUBLIC_DIR ?? join(PROJECT_ROOT, "public")
}

function webPathToDisk(publicDir, webPath) {
  // webPath is always /media/<uuid>/filename — prepend public/
  return join(publicDir, webPath)
}

/**
 * Regenerate the thumbnail at thumbPath using the original at originalPath.
 * Applies the fixed pipeline: .rotate() → .resize(400, withoutEnlargement) → .webp(80).
 * Overwrites thumbPath in place. originalPath is read-only.
 *
 * Exported for use in tests.
 *
 * @param {string} originalPath  Absolute path to the original image file
 * @param {string} thumbPath     Absolute path to the thumbnail to overwrite
 */
export async function regenerateThumb(originalPath, thumbPath) {
  const buf = await readFile(originalPath)
  await sharp(buf)
    .rotate()
    .resize({ width: 400, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(thumbPath)
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error("Error: DATABASE_URL environment variable is required")
    console.error("  export DATABASE_URL=postgres://user:pass@host/dbname")
    process.exit(1)
  }

  const isDryRun = process.argv.includes("--dry-run")
  const publicDir = resolvePublicDir()

  console.log("within — regenerate-thumbnails backfill")
  console.log(`  public dir : ${publicDir}`)
  console.log(`  dry run    : ${isDryRun}`)
  console.log("")

  const pool = new Pool({ connectionString: databaseUrl })

  let processed = 0
  let errors = 0

  try {
    const { rows } = await pool.query(
      `SELECT id, file_path, thumbnail_path
       FROM media
       WHERE thumbnail_path IS NOT NULL
         AND thumbnail_path != file_path
       ORDER BY id`
    )

    console.log(`Found ${rows.length} row(s) with dedicated thumbnails to regenerate\n`)

    for (const row of rows) {
      const originalPath = webPathToDisk(publicDir, row.file_path)
      const thumbPath = webPathToDisk(publicDir, row.thumbnail_path)

      if (isDryRun) {
        console.log(`  [dry] ${row.thumbnail_path}`)
        continue
      }

      try {
        await regenerateThumb(originalPath, thumbPath)
        console.log(`  [ok]  ${row.thumbnail_path}`)
        processed++
      } catch (err) {
        console.error(`  [err] ${row.thumbnail_path}: ${err.message}`)
        errors++
      }
    }
  } finally {
    await pool.end()
  }

  if (!isDryRun) {
    console.log(`\nDone: ${processed} regenerated, ${errors} error(s)`)
    if (errors > 0) process.exit(1)
  }
}

// Run only when invoked directly, not when imported by tests
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
