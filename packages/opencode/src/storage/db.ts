import { createClient, type Client as LibsqlClient } from "@libsql/client"
import { type LibSQLDatabase, drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import crypto from "node:crypto"
export * from "drizzle-orm"
import { Context } from "../util/context"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import * as schema from "./schema"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export namespace Database {
  export const Path = iife(() => {
    const channel = Installation.CHANNEL
    if (["latest", "beta"].includes(channel) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
      return path.join(Global.Path.data, "opencode.db")
    const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
    return path.join(Global.Path.data, `opencode-${safe}.db`)
  })

  type Schema = typeof schema
  type Client = LibSQLDatabase<Schema>

  export type Transaction = Client
  export type TxOrDb = Client

  type Journal = { sql: string; timestamp: number; name: string }[]

  const state = {
    libsqlClient: undefined as LibsqlClient | undefined,
    clientPromise: undefined as Promise<Client> | undefined,
  }

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
          name,
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  async function applyBundledMigrations(libsqlClient: LibsqlClient, entries: Journal) {
    const table = "__drizzle_migrations"
    await libsqlClient.execute(
      `CREATE TABLE IF NOT EXISTS "${table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER, name TEXT, applied_at TEXT)`,
    )
    const { rows } = await libsqlClient.execute(`SELECT name FROM "${table}"`)
    const applied = new Set(rows.map((r) => String(r.name)))
    for (const entry of entries) {
      if (applied.has(entry.name)) continue
      const hash = crypto.createHash("sha256").update(entry.sql).digest("hex")
      for (const stmt of entry.sql.split("--> statement-breakpoint")) {
        const s = stmt.trim()
        if (s) await libsqlClient.execute(s)
      }
      await libsqlClient.execute({
        sql: `INSERT INTO "${table}" (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)`,
        args: [hash, entry.timestamp, entry.name, new Date().toISOString()],
      })
    }
  }

  async function initClient(): Promise<Client> {
    log.info("opening database", { path: Path })

    // libsql's native TLS (rustls + native-certs) needs SSL_CERT_FILE set in
    // environments where the system cert store isn't auto-detected (e.g. bundled binaries).
    if (!process.env["SSL_CERT_FILE"]) {
      const candidates =
        process.platform === "darwin"
          ? ["/etc/ssl/cert.pem"]
          : ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem"]
      for (const cert of candidates) {
        if (existsSync(cert)) {
          process.env["SSL_CERT_FILE"] = cert
          break
        }
      }
    }

    const isRemote = !!Flag.OPENCODE_DB_URL && !Flag.OPENCODE_DB_URL.startsWith("file:")

    const libsqlClient = isRemote
      ? createClient({
          url: Flag.OPENCODE_DB_URL!,
          authToken: Flag.OPENCODE_DB_TOKEN,
        })
      : createClient({
          url: Flag.OPENCODE_DB_URL ?? `file:${Path}`,
        })

    state.libsqlClient = libsqlClient

    const db = drizzle({ client: libsqlClient, schema })

    // Apply schema migrations
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))

    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      if (typeof OPENCODE_MIGRATIONS !== "undefined") {
        await applyBundledMigrations(libsqlClient, entries)
      } else {
        await migrate(db, { migrationsFolder: path.join(import.meta.dirname, "../../migration") })
      }
    }

    return db
  }

  export const Client = {
    reset() {
      state.clientPromise = undefined
      state.libsqlClient = undefined
    },
    get: async (): Promise<Client> => {
      if (!state.clientPromise) {
        state.clientPromise = initClient()
      }
      return state.clientPromise
    },
  }

  export async function close() {
    state.libsqlClient?.close()
    state.libsqlClient = undefined
    state.clientPromise = undefined
  }

  export async function sync() {
    if (state.libsqlClient && "sync" in state.libsqlClient) {
      await (state.libsqlClient as any).sync()
    }
  }

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export async function use<T>(callback: (trx: TxOrDb) => Promise<T>): Promise<T> {
    try {
      return await callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const client = await Client.get()
        const effects: (() => void | Promise<void>)[] = []
        const result = await ctx.provide({ effects, tx: client }, () => callback(client))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  export async function transaction<T>(callback: (tx: TxOrDb) => Promise<T>): Promise<T> {
    try {
      return await callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const client = await Client.get()
        const effects: (() => void | Promise<void>)[] = []
        const result = await (client as any).transaction(async (tx: TxOrDb) => {
          return ctx.provide({ tx, effects }, () => callback(tx))
        })
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }
}
