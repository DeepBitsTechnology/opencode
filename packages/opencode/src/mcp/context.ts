import { Context } from "../util/context"

interface McpCallContext {
  mcpHeaders?: Record<string, string>
}

const context = Context.create<McpCallContext>("mcp-call")

export const McpCallContext = {
  provide<R>(value: McpCallContext, fn: () => R): R {
    return context.provide(value, fn)
  },

  get current(): McpCallContext | undefined {
    try {
      return context.use()
    } catch {
      return undefined
    }
  },
}
