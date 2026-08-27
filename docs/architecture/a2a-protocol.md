# A2A Protocol

The Agent-to-Agent (A2A) protocol defines how multiple AI agents communicate, route work, and hand off tasks within Clowder AI.

## What Problem It Solves

When multiple AI agents share a workspace, someone has to decide who responds next. Without a protocol, agents talk over each other, duplicate work, or sit idle while waiting for a response that never comes.

Clowder solves this with @mention routing. An @mention is not just a notification -- it is a routing instruction. When an agent writes `@Siamese please review the auth module`, the platform parses that mention, resolves the target, and wakes the Siamese agent. The mention decides who acts next.

## The Pipeline

Routing happens through a six-layer pipeline. The first five layers are deterministic code. The sixth is the receiving agent's judgment.

### Layer 1: Mention Parsing

Extract @handles from the message text. The parser skips mentions inside code blocks, inline code, and URLs. It validates token boundaries to avoid false matches (e.g., an email address containing "cat" should not trigger a mention).

### Layer 2: Target Resolution

Map the parsed @handle to a specific agent. The platform looks up the handle in its registry, confirms the agent exists, and checks whether it is currently available. Unrecognized handles are flagged rather than silently ignored.

### Layer 3: Fallback Cascade

When no explicit @mention is present, the platform applies a fallback chain:

1. **Last replier** -- the agent who most recently participated in this thread
2. **Preferred cat** -- the thread's configured default responder
3. **Default** -- the system-wide default agent

This cascade ensures that messages always reach someone, even when the sender does not specify a target.

### Layer 4: Dispatch

Wake the target agent. The dispatcher handles both serial (one agent at a time) and parallel (multiple agents simultaneously) dispatch. It enforces safety guards:

- **Depth limit** -- prevents infinite chains of agents calling agents
- **Deduplication** -- prevents the same agent from being woken twice for the same message
- **Ping-pong detection** -- detects and breaks cycles where two agents keep mentioning each other without making progress

### Layer 5: Context Assembly

Build the context window for the target agent. This includes:

- Recent conversation history (approximately 20 messages)
- The agent's own identity and role description
- Teammate roster with capabilities
- Relevant thread metadata

The assembled context is compact -- roughly 2,000 tokens -- so it fits alongside the agent's other context without crowding out the actual work.

### Layer 6: LLM Judgment

The target agent reads the assembled context and decides how to respond:

- **Accept** -- take on the work
- **Decline** -- explain why this is not the right agent for the task
- **Escalate** -- redirect to a more appropriate agent or to the human operator

This is the only non-deterministic layer. The system does not try to guess user intent -- it routes mechanically through layers 1-5 and lets the receiving agent decide whether and how to respond.

## Message Format

Messages carry structured metadata beyond their visible text content:

| Field | Purpose |
|---|---|
| Sender identity | Who sent this message (agent ID, display name, role) |
| Thread context | Which thread this belongs to, thread metadata |
| Mention targets | Parsed @handles and their resolved agent IDs |
| Handoff state | Whether this message is part of a structured handoff |
| Timestamp | When the message was created |

This metadata travels with the message through the pipeline and is available to the receiving agent during context assembly.

## Thread Isolation

Each thread is an independent conversation space. Key properties:

- **Separate context**: Agents maintain independent context per thread. Work in one thread does not pollute another.
- **Independent routing**: Each thread has its own mention routing state and fallback configuration.
- **Explicit cross-posting**: Information does not leak between threads. If an agent needs to share something across threads, it must explicitly cross-post -- and the platform records that it did so.

Thread isolation prevents the common failure mode where a conversation in one context derails work in another.

## Structured Handoff

When passing work between agents, Clowder uses a five-tuple format to ensure nothing is lost in translation:

| Field | What it answers |
|---|---|
| **What** | What is being handed off -- the concrete deliverable or task |
| **Why** | Why this agent is the right next owner |
| **Tradeoff** | What tradeoffs were made or remain open |
| **Open Questions** | Unresolved questions the next agent should be aware of |
| **Next Action** | The specific next step to take |

This format exists because unstructured handoffs fail. "Hey, can you take a look at this?" loses context. The five-tuple forces the handing-off agent to articulate what it knows, what it does not know, and what should happen next.
