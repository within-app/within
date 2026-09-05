// archiver@8 dropped the CommonJS factory function (`archiver("zip", opts)`)
// in favour of format-specific classes (`ZipArchive`, `TarArchive`, `JsonArchive`)
// and is now ESM-only. @types/archiver@7.0.0 (DefinitelyTyped) still describes
// the old `export =` factory shape and does not know these classes, so we
// declare the subset we actually use here instead of patching the upstream
// types package. See https://github.com/archiverjs/node-archiver/issues/846.
declare module "archiver" {
  import type { Transform } from "stream"
  import type { ZlibOptions } from "zlib"

  interface ArchiverEntryData {
    name: string
    date?: Date | string
    mode?: number
    prefix?: string
  }

  interface ArchiverZipOptions {
    comment?: string
    forceLocalTime?: boolean
    forceZip64?: boolean
    namePrependSlash?: boolean
    store?: boolean
    zlib?: ZlibOptions
    statConcurrency?: number
  }

  interface ArchiverError extends Error {
    code: string
    data: unknown
  }

  class Archiver extends Transform {
    append(source: NodeJS.ReadableStream | Buffer | string, data?: ArchiverEntryData): this
    file(filepath: string, data: ArchiverEntryData): this
    finalize(): Promise<void>
    on(event: "error" | "warning", listener: (error: ArchiverError) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
  }

  export class ZipArchive extends Archiver {
    constructor(options?: ArchiverZipOptions)
  }

}
