# F273 visual-test artifacts

`update-modal-v0.10.0-to-v0.12.0.png` is a **test-only screenshot**, not evidence that the ordinary web application checks for desktop updates.

The exact-head `DesktopUpdatePrompt` was mounted on an isolated Next.js server. Playwright injected a mock Electron `desktopBridge` and a v0.10.0 → v0.12.0 payload so the desktop-only modal could be inspected. Without that bridge, the normal browser component renders nothing; this boundary is covered by `DesktopUpdatePrompt.test.tsx`.

The screenshot verifies:

- rendered Markdown headings, emphasis, table, and inline code;
- the main-owned canonical v0.12.0 release link;
- current version v0.10.0;
- Skip This Version, Later, and Download actions.
