# Collaborative Document Sync Engine

A real-time collaborative text editor built on a sequence CRDT, in TypeScript,
over WebSockets. Several people type into the same document at once, every
edit lands locally straight away, and every replica ends up with the same text
without anyone arbitrating the order.

```
npm install
npm run demo      # builds everything and serves the demo on http://127.0.0.1:8080
```

Open that URL in two windows. Each window picks its own colour and name, and
you'll see the other caret move as you type. `#some-name` on the end of the URL
picks a different document.

```
npm test          # 52 tests: convergence, framing, room behaviour, reconnect
npm run bench     # keystroke-to-peer latency against a server-ordered baseline
npm run soak      # 12 real websocket clients typing at a real server
```

## Layout

| package | what's in it |
| --- | --- |
| `packages/crdt` | the sequence CRDT, version vectors, op coalescing |
| `packages/protocol` | binary framing for ops, snapshots and presence |
| `packages/server` | rooms, snapshot storage, the websocket gateway |
| `packages/client` | the session a browser talks to: batching, presence, reconnect |
| `packages/demo` | a textarea wired to a session, with remote carets |
| `bench` | the latency model and the real-stack soak |

## How the text stays consistent

The document is an **RGA** — a replicated growable array. Every character gets
an id of `{ site, seq }`, where `site` is the random number a client picks when
it opens the document and `seq` counts up by one for each id that site hands
out. An insert names the character it was typed after; that anchor is all a
replica needs to place it.

When two people insert after the same anchor, both replicas order the two runs
by Lamport stamp, falling back to site id for ties. Neither replica asks the
other anything, and both land on the same answer. Deletes leave a tombstone
behind so a concurrent insert into a range someone else just deleted still has
somewhere to attach.

Two things make this cheap enough to be practical:

**Characters are stored in runs, not one node each.** A block holds every
character that one site typed consecutively, splits when someone inserts into
the middle of it, and merges back when the pieces line up again. Typing 200
characters produces one block, not 200 nodes. Because the seqs and Lamport
stamps inside a block are contiguous, comparing the block's first character is
equivalent to comparing every character in it, so the ordering scan works on
whole blocks.

**Causality is one integer per site.** `seq` is gap-free, so "have I seen
everything site 7 published?" is a single comparison. Ops that arrive before
their anchor does are parked and retried when it shows up, which means the
transport can deliver in whatever order it likes — there's a test that feeds a
replica a fully shuffled op stream and checks it still converges.

Deletes deliberately don't get coalesced. An op's id block is one seq wide for
a delete, so merging two of them would leave a hole in the sender's seq space
and every peer would park the batch forever waiting for an id that never
arrives. Inserts have no such problem and are merged aggressively.

## What happens on the wire

Ops in a batch look almost identical to each other: same site, consecutive
seqs, and an origin that is nearly always the character immediately before.
The framing puts a flag byte in front of each op saying which of those fields
can be inferred from the previous one. A single keystroke is **9 bytes** on the
wire against **101 bytes** for the equivalent JSON, and decodes in 0.21µs
instead of 4.72µs.

The server broadcasts by encoding once and handing the same buffer to every
socket, rather than re-serialising per recipient.

Clients treat their batch interval as a *floor between sends*, not a delay
before each one. Type on an idle connection and the keystroke leaves
immediately; type faster than the floor and the burst piles up and leaves as a
single run op. An earlier version delayed every batch by a flat 16ms, which
was a straight latency tax on anyone typing slower than 60 characters a second.

## Reconnecting

A client keeps its site id across reconnects, so ops it made while offline stay
valid. On reconnect it sends its version vector; the server either replies with
just the ops it missed, or — if it's fallen behind the server's op log window —
with a full snapshot. A snapshot is *folded into* the existing replica rather
than replacing it, so anything typed while offline survives and syncs once the
connection is back.

The server keeps a bounded op log rather than trimming to the last snapshot,
so a routine save doesn't force a full document on everyone who happened to be
a few seconds behind.

## Numbers

### Keystroke to peer

`npm run bench`. Stage costs and frame sizes are measured off the real
encoders and the real CRDT; only the network is modelled. The baseline is a
**server-ordered (OT-style) pipeline**, where a client may only have one op
outstanding and buffers the rest until the server acknowledges — which is
inherent to operational transform, not a strawman. 40 documents, 8 editors
each, everyone typing in realistic bursts.

| round trip | server-ordered p95 | this engine p95 | change |
| --- | --- | --- | --- |
| 30 ms | 23.6 ms | 23.4 ms | -1% |
| 120 ms | 89.9 ms | 68.4 ms | **-24%** |
| 180 ms | 175.5 ms | 98.3 ms | **-44%** |
| 240 ms | 237.1 ms | 128.4 ms | **-46%** |
| 300 ms | 287.1 ms | 158.3 ms | **-45%** |

Read that honestly: on a low-latency link everything is propagation-bound and
the pipelines tie. The gap opens once the round trip is long enough that
ack-gating stalls a typing burst, and from about 120ms it's worth 24–46% at
p95. Not having to wait for an acknowledgement is a property of the CRDT, not
a tuning trick — there is nothing to acknowledge.

Server egress over the same run drops from **12.8 Mbit/s to 1.1 Mbit/s** and
CPU from 2.6% to 0.2%. That mostly buys capacity headroom rather than latency,
because frames this small don't queue until a link is nearly saturated.

### Real stack

`npm run soak` starts the actual server, opens actual WebSockets and types at
them. With 40 clients at 15 characters a second for 15 seconds:

```
characters typed      7153  (474/s across the room)
document length       7153
replicas agree        yes
ops observed at peers 278967
loopback latency      p50 14.4ms   p95 86.4ms   p99 106.9ms
```

Server and all 40 clients share one event loop here, so those numbers include
contention that a real deployment wouldn't have. The point of the run is the
`replicas agree` line.

## Known gaps

- **Tombstones are never collected.** A long-lived document keeps every deleted
  character forever. Doing this properly needs a causal stability check across
  all sites, which the server has the information for but doesn't do yet.
- **Index lookups are linear** in the number of blocks. Fine for documents in
  the tens of thousands of characters; a balanced index over block lengths is
  the fix beyond that.
- **No authentication or authorisation.** The server checks that a client only
  publishes ops under its own site id and sanitises document names into file
  names, and that's it.
- The demo binds a plain `<textarea>`, so it handles plain text only.
