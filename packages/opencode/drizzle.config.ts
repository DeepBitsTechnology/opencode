import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "turso",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url: process.env["OPENCODE_DB_URL"] ?? `file:${process.env["HOME"]}/.local/share/opencode/opencode.db`,
    authToken: process.env["OPENCODE_DB_TOKEN"],
  },
})
