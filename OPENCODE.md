# OpenCode Runtime Notes

This file is loaded as the project-level OpenCode instruction addendum.

## Interaction Channels

- Do not use the `question` tool for Cat Cafe handoffs; project config sets `permission.question` to `deny`.
- For structured UI messages, use `cat_cafe_create_rich_block` through the Cat Cafe callback tools instead of prose-only placeholders.
- Keep route instructions in the native L0 system prompt; this file is only the OpenCode-specific runtime addendum.
