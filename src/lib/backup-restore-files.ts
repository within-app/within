/**
 * The backup folder as the app sees it: mounted read-only at /backup (see
 * x-backup-dir in docker-compose.yml). Listing works because backup-full.sh
 * keeps the folder at 711 and db/ at 755; the dumps themselves stay 600 root,
 * only their names, sizes and the counts sidecar are readable here.
 */
import { readdir, readFile, stat, statfs } from "fs/promises"
import { join } from "path"
import { DUMP_NAME_RE, parseDumpMeta, type DumpInfo } from "@/lib/backup-restore"

export function backupDir(): string {
  return process.env.BACKUP_DIR ?? "/backup"
}

/** Newest first. null when the backup folder is not mounted (no db/ folder). */
export async function listDumps(dir = backupDir()): Promise<DumpInfo[] | null> {
  const dbDir = join(dir, "db")
  let names: string[]
  try {
    names = await readdir(dbDir)
  } catch {
    return null
  }
  const dumps: DumpInfo[] = []
  for (const file of names.filter((n) => DUMP_NAME_RE.test(n)).sort().reverse()) {
    let sizeBytes = 0
    let takenAt = new Date(0)
    try {
      const s = await stat(join(dbDir, file))
      sizeBytes = s.size
      takenAt = s.mtime
    } catch {
      continue // vanished between readdir and stat (retention) — skip
    }
    let meta = { entries: null as number | null, media: null as number | null }
    try {
      meta = parseDumpMeta(await readFile(join(dbDir, `${file}.meta.json`), "utf8"))
    } catch {
      // no sidecar (dump predates it) — counts stay unknown
    }
    dumps.push({ file, takenAt: takenAt.toISOString(), sizeBytes, ...meta })
  }
  return dumps
}

export async function dumpExists(file: string, dir = backupDir()): Promise<boolean> {
  if (!DUMP_NAME_RE.test(file)) return false
  try {
    return (await stat(join(dir, "db", file))).isFile()
  } catch {
    return false
  }
}

/** Used/total bytes of the filesystem behind the backup folder; null when it is missing. */
export async function destUsage(dir = backupDir()): Promise<{ usedBytes: number; totalBytes: number } | null> {
  try {
    const s = await statfs(dir)
    return { usedBytes: (s.blocks - s.bfree) * s.bsize, totalBytes: s.blocks * s.bsize }
  } catch {
    return null
  }
}
