import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Clock, Deferred, Effect, Queue, Ref } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

function eventResponse(events: EventV2.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    // Sliding (drop-oldest) caps memory if a consumer stalls: the producer below is
    // a fire-and-forget bus callback that must never backpressure the event bus, so
    // it cannot suspend on a full queue. The watchdog is the real cleanup; this is a
    // backstop bounding worst-case growth during the detection window. Dropped events
    // for sync-tracked aggregates are recoverable via /sync after the client reconnects.
    const queue = yield* Queue.sliding<EventV2.Payload>(10_000)
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => Queue.offerUnsafe(queue, event)))
    yield* Effect.addFinalizer(() => unsubscribe)

    // Zombie-consumer detection. A client that stops reading without closing the
    // socket (CLOSE_WAIT / full TCP send buffer) leaves the Effect stream suspended
    // on write backpressure forever — no socket error is ever raised, so the body
    // fiber never fails and the finalizer above never runs. The heartbeat below
    // emits every 10s, so on a healthy connection lastEmit refreshes at least that
    // often; once the sink stops draining, lastEmit goes stale. If nothing has been
    // written for IDLE_TIMEOUT_MS we interrupt the body, which closes the scope and
    // runs the finalizer.
    const IDLE_TIMEOUT_MS = 30_000
    const lastEmit = yield* Ref.make(yield* Clock.currentTimeMillis)
    const interrupt = yield* Deferred.make<void>()
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("5 seconds")
          const now = yield* Clock.currentTimeMillis
          const last = yield* Ref.get(lastEmit)
          if (now - last > IDLE_TIMEOUT_MS) {
            yield* Effect.logInfo("event consumer stalled, disconnecting")
            yield* Deferred.succeed(interrupt, void 0)
            return
          }
        }
      }),
    )
    const stream = Stream.fromQueue(queue).pipe(
      Stream.filter(
        (event) =>
          event.location?.directory === instance.directory &&
          (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID),
      ),
      Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data })),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>((queue) => {
      const listener = (event: {
        directory?: string
        payload: { id?: string; type?: string; properties?: unknown }
      }) => {
        if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
        Queue.offerUnsafe(queue, {
          id: event.payload.id ?? eventID(),
          type: "server.instance.disposed",
          properties: event.payload.properties ?? {},
        })
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
    })
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        // Record progress on every element the sink actually pulls (events and
        // heartbeats). Streams are pull-based, so this stops refreshing the instant
        // the socket write blocks — which is exactly what the watchdog detects.
        Stream.tap(() => Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(lastEmit, now))),
        Stream.interruptWhen(Deferred.await(interrupt)),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
