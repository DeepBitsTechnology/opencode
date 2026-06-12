import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

function withTmp<A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
}

describe("FSUtil.writeNoFollow", () => {
  it.live("creates a file and any missing parent directories", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const fsu = yield* FSUtil.Service
        const target = path.join(directory, "nested", "deep", "file.txt")

        yield* fsu.writeNoFollow(target, "hello")

        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("hello")
      }).pipe(Effect.provide(LayerNode.compile(FSUtil.node))),
    ),
  )

  it.live("refuses to follow a symlink at the final component", () =>
    withTmp((directory) =>
      withTmp((outside) =>
        Effect.gen(function* () {
          if (process.platform === "win32") return

          const fsu = yield* FSUtil.Service
          const external = path.join(outside, "secret.txt")
          const link = path.join(directory, "link.txt")
          yield* Effect.promise(async () => {
            await fs.writeFile(external, "original")
            await fs.symlink(external, link)
          })

          // Writing the symlinked path must fail rather than follow the link.
          const error = yield* fsu.writeNoFollow(link, "evil").pipe(Effect.flip)
          expect(error).toBeDefined()

          // The external target is untouched and the symlink itself is preserved
          // (not replaced by a regular file).
          expect(yield* Effect.promise(() => fs.readFile(external, "utf8"))).toBe("original")
          expect(yield* Effect.promise(() => fs.lstat(link).then((stat) => stat.isSymbolicLink()))).toBe(true)
        }).pipe(Effect.provide(LayerNode.compile(FSUtil.node))),
      ),
    ),
  )

  it.live("overwrites an existing regular file in place", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const fsu = yield* FSUtil.Service
        const target = path.join(directory, "file.txt")
        yield* Effect.promise(() => fs.writeFile(target, "before"))

        yield* fsu.writeNoFollow(target, "after")

        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
      }).pipe(Effect.provide(LayerNode.compile(FSUtil.node))),
    ),
  )
})
