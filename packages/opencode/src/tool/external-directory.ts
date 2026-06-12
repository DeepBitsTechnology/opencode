import path from "path"
import { realpath } from "fs/promises"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import type { InstanceContext } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

export type AuthorizedPath = {
  requested: string
  canonical: string
  external: boolean
}

function normalize(target: string) {
  const absolute = path.resolve(target)
  return process.platform === "win32" ? FSUtil.normalizePath(absolute) : absolute
}

function slash(target: string) {
  return process.platform === "win32" ? FSUtil.normalizePathPattern(target) : target.replaceAll("\\", "/")
}

/**
 * Resolve an existing path's canonical location, yielding undefined for any
 * path that cannot be resolved (ENOENT, ELOOP, EACCES, ...). Runs
 * asynchronously so the realpath syscall never blocks the event loop on the
 * write hot path, and never throws so a broken/looping symlink fails gracefully
 * rather than crashing the tool.
 */
const canonicalRealPath = (target: string) =>
  Effect.tryPromise(() => realpath(target)).pipe(Effect.orElseSucceed(() => undefined as string | undefined))

function resolveCanonicalTarget(requested: string) {
  return FSUtil.resolveCanonical(requested, canonicalRealPath, normalize)
}

type ExternalDirectoryRequest = {
  glob: string
  dir: string
  filepath: string
}

function externalDirectoryRequest(
  target: string,
  ins: InstanceContext,
  options?: Options,
): ExternalDirectoryRequest | undefined {
  const full = normalize(target)
  if (containsPath(full, ins)) return undefined

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  return { glob: slash(path.join(dir, "*")), dir, filepath: full }
}

export const authorizeExternalDirectoryEffect = Effect.fn("Tool.authorizeExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return undefined

  const requested = normalize(target)
  // Resolve the canonical target even when bypassing so a later
  // assertAuthorizedPathUnchangedEffect compares against the real path rather
  // than the un-resolved request.
  const canonical = yield* resolveCanonicalTarget(requested)
  if (options?.bypass) return { requested, canonical, external: false } satisfies AuthorizedPath

  const ins = yield* InstanceState.context

  // Approve the directory the caller named. Only when the requested path lives
  // inside the project but resolves (via a symlink) to an external location do
  // we fall back to asking for the canonical directory instead — so a single
  // operation never raises more than one prompt, and approving an external
  // path the caller named does not also require approving its symlink target.
  const requestedRequest = externalDirectoryRequest(requested, ins, options)
  const canonicalRequest =
    requestedRequest === undefined && canonical !== requested
      ? externalDirectoryRequest(canonical, ins, options)
      : undefined
  const request = requestedRequest ?? canonicalRequest

  if (request) {
    yield* ctx.ask({
      permission: "external_directory",
      patterns: [request.glob],
      always: [request.glob],
      metadata: {
        filepath: request.filepath,
        parentDir: request.dir,
      },
    })
  }

  return {
    requested,
    canonical,
    external: requestedRequest !== undefined || canonicalRequest !== undefined,
  } satisfies AuthorizedPath
})

export const assertAuthorizedPathUnchangedEffect = Effect.fn("Tool.assertAuthorizedPathUnchanged")(function* (
  authorized?: AuthorizedPath,
) {
  if (!authorized) return

  const canonical = yield* resolveCanonicalTarget(authorized.requested)
  if (canonical !== authorized.canonical) {
    return yield* Effect.fail(
      new Error(`Path changed after permission approval: ${authorized.requested}. Please retry the tool call.`),
    )
  }
})

/**
 * Single chokepoint for tool writes: re-verify the authorized path still
 * resolves to the canonical location captured at approval time, then write to
 * that resolved, symlink-free canonical path with a primitive that refuses to
 * follow a symlink at the final component. Writing the canonical path (rather
 * than the requested path) means a swap of the requested path into a symlink is
 * bypassed entirely, and O_NOFOLLOW closes the narrow window between the
 * re-check and the open in which the canonical leaf itself could be swapped.
 *
 * Routing every tool write through this guard (instead of calling
 * FSUtil.writeNoFollow directly) keeps the symlink re-check co-located with the
 * write so a new call site cannot silently skip it.
 */
export const writeAuthorized = Effect.fn("Tool.writeAuthorized")(function* (
  afs: FSUtil.Interface,
  authorized: AuthorizedPath | undefined,
  target: string,
  content: string | Uint8Array,
  mode?: number,
) {
  yield* assertAuthorizedPathUnchangedEffect(authorized)
  yield* afs.writeNoFollow(authorized?.canonical ?? target, content, mode)
})

/**
 * Remove `target` after re-verifying the authorized path, mirroring
 * writeAuthorized. remove does not follow a symlink at the final component (it
 * unlinks the link itself, not its target), so a last-moment swap of the target
 * into a symlink cannot delete an external file; the re-check guards swaps of an
 * ancestor directory.
 */
export const removeAuthorized = Effect.fn("Tool.removeAuthorized")(function* (
  afs: FSUtil.Interface,
  authorized: AuthorizedPath | undefined,
  target: string,
) {
  yield* assertAuthorizedPathUnchangedEffect(authorized)
  yield* afs.remove(target)
})

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  const authorized = yield* authorizeExternalDirectoryEffect(ctx, target, options)
  return Boolean(authorized?.external)
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}
