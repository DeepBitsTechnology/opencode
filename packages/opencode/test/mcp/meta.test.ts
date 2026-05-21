import { describe, expect, test } from "bun:test"
import { _convertMcpTool } from "../../src/mcp/index"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"

const fakeTool: MCPToolDef = {
  name: "list_files",
  description: "List files in a directory",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}

function makeClient(onCallTool: (params: unknown) => void) {
  return {
    callTool: (params: unknown, _resultSchema: unknown, _options: unknown) => {
      onCallTool(params)
      return Promise.resolve({ content: [{ type: "text", text: "ok" }] })
    },
  } as any
}

describe("mcp._meta", () => {
  test("passes _meta when session metadata mcpMeta is set", async () => {
    let captured: unknown
    const client = makeClient((params) => (captured = params))
    const meta = { tenant: "acme", actor: "sheng@example.com" }
    const tool = _convertMcpTool(fakeTool, client, undefined, meta)
    await (tool.execute as Function)({ path: "/tmp" }, { toolCallId: "c1", abortSignal: undefined })
    expect((captured as any)._meta).toEqual(meta)
    expect((captured as any).name).toBe("list_files")
  })

  test("omits _meta when session metadata mcpMeta is undefined", async () => {
    let captured: unknown
    const client = makeClient((params) => (captured = params))
    const tool = _convertMcpTool(fakeTool, client, undefined, undefined)
    await (tool.execute as Function)({ path: "/tmp" }, { toolCallId: "c2", abortSignal: undefined })
    expect((captured as any)._meta).toBeUndefined()
  })
})
