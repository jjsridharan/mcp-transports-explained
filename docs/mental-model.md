# MCP Mental Model

This document describes how to **think about Model Context Protocol (MCP)** independent of any specific transport or SDK.

If you understand this file, the rest of the repository will feel intuitive.

---

## 1. What MCP is (at the protocol level)

MCP is a **message protocol** built on JSON-RPC.

It is not an API, and it is not a transport.

At its core:

* Clients and servers exchange structured messages
* Tools are exposed as JSON-RPC methods
* All interactions are expressed as requests, notifications, and responses
* Transports exist only to move these messages

Think in terms of **messages first, connections second**.

---

## 2. The three message types

Every MCP interaction is composed of three JSON-RPC message types.

| Type         | Has `id` | Expects Response | Example                  |
| ------------ | -------- | ---------------- | ------------------------ |
| Request      | Yes      | Yes              | `tools/call`             |
| Notification | No       | No               | `notifications/progress` |
| Response     | Yes      | N/A              | Tool result              |

### Requests

Requests initiate work and always expect a response.

They include an `id` used for correlation.

### Notifications

Notifications carry information but do not expect replies.

They are commonly used for:

* progress updates
* cancellation
* server-side events

### Responses

Responses complete requests.

They contain either:

* `result`, or
* `error`

---

## 3. The request lifecycle

A typical MCP request follows this conceptual flow:

```
Client  →  Request (id = N)
Server  →  Progress (optional)
Server  →  Progress (optional)
Server  →  Response (id = N)
```

Important properties:

* Progress is optional
* Only one final response exists per request
* Cancellation may interrupt the flow
* Transport disconnections do not imply cancellation

  * If a connection drops, the server may still be executing the request
  * The client must send an explicit `cancel` notification to stop work
  * This allows retries and reconnections without losing in-flight work

The lifecycle is protocol-level and independent of transport.

---

## 4. Sessions vs stateless execution

MCP supports two execution models.

### Session-based mode

In session mode:

* The server issues an `Mcp-Session-Id`
* Multiple requests share server-side context
* Authentication and user identity are preserved
* Client elicitation and follow-ups are enabled

This model supports richer interaction.

### Stateless mode

In stateless mode:

* No session identifier is used
* Each request is independent
* No shared execution context exists
* Servers can scale horizontally without affinity

This model prioritizes scalability and simplicity.

MCP intentionally supports both.

---

## 5. Initialization and capability negotiation

The `initialize` / `notifications/initialized` phase exists to:

* exchange supported capabilities
* negotiate schemas and tools
* establish interaction patterns
* prepare for multi-step workflows

Even in stateless deployments, initialization may still be useful for discovery and negotiation.

Initialization enables protocol-level coordination that cannot be performed per request.

---

## 6. Where streaming fits

Streaming is **not a core MCP concept**.

It is an optional transport feature.

Conceptually:

* Requests are asynchronous
* Responses may arrive later
* Progress may be emitted in between

Streaming only affects how these messages are delivered.

In Streamable HTTP, streaming is applied to response bodies.

In legacy SSE, streaming is applied to session-wide connections.

The protocol itself remains unchanged.

---

## 7. Transport mapping

Different transports map the same protocol concepts in different ways.

| Concept         | Legacy SSE                                   | Streamable HTTP                                  |
| --------------- | -------------------------------------------- | ------------------------------------------------ |
| Primary channel | Global stream                                | Per-request response                             |
| Correlation     | Client-side (client matches `id` → response) | Server/HTTP (each POST maps to its own response) |
| State           | Session                                      | Optional                                         |
| Scaling         | Harder                                       | Easier                                           |
| Retry           | Complex                                      | Simpler                                          |

The transport determines where complexity lives.

---

---

## 8. Failure, retries, and recovery

MCP is designed to tolerate failures.

Important principles:

* Disconnection ≠ cancellation
* Clients must cancel explicitly
* Requests may be retried
* Responses must be idempotent when possible
* Streaming failures should not corrupt state

Streamable HTTP simplifies recovery by isolating failures per request.

---

## 9. Why MCP evolved

Early MCP deployments favored session-wide SSE because it was easy to reason about.

As deployments grew, new constraints emerged:

* load balancing
* multi-region routing
* failure isolation

Streamable HTTP reflects these realities.

It preserves MCP semantics while improving operational characteristics.

---

## 10. Summary mental model

Think about MCP in terms of:

1. Messages, not connections
2. Requests, not streams
3. Correlation, not ordering
4. Optional state, not mandatory sessions
5. Protocol first, transport second

If you internalize these ideas, MCP behavior across transports becomes predictable.
