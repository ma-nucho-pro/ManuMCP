# Changes

## 1.5.0

- Add an idempotent `configure-clients.mjs` helper for Codex, Claude Code, Gemini CLI and Cursor.
- Add one-command agent bootstrap options to configure detected local clients and open the ChatGPT web settings page.
- Preserve existing Cursor MCP servers and create a timestamped backup before updating the `manumcp` entry.
- Document the complete agent-driven flow, including the browser authorization boundary for ChatGPT accounts.

## 1.4.0

- Make the local agent cross-platform for Windows, macOS and POSIX command/process workflows.
- Make `pc:/` default to the complete host filesystem root and discover mounted Windows drive letters as `pc-d:/`, `pc-f:/`, and similar aliases.
- Add `list_storage_volumes` so clients can discover every mounted computer volume before choosing a path.
- Add macOS desktop integration through JXA, CoreGraphics, `screencapture`, `open`, `ps` and `kill`.
- Add portable Unix installers, launchd/systemd startup helpers and cross-platform tunnel stdio entrypoints.
- Expand the public documentation for ChatGPT, Codex, Claude Code, Gemini CLI, Cursor and other standard MCP clients.

## 1.3.0

- Add confirmed Windows command execution, application launching, process management and file/folder opening.
- Add screen capture, visible-window discovery/focus/close, cursor inspection, mouse control, Unicode typing and hotkeys.
- Keep every interactive or state-changing operating-system action behind a signed one-time confirmation token.

## 1.2.0

- Add `downloads:/` for the real Windows Downloads folder and `pc:/` for the complete Windows user profile.
- Allow an explicitly configured broad `pc:/` root such as `C:\` while keeping system directories, credentials and other protected paths denied.
- Handle existing drive roots without trying to create them, so the Windows scheduled agent starts correctly with `-PcRoot "C:\"`.
- Accept natural aliases (`descargas`, `escritorio`, `ordenador`) and absolute Windows paths that resolve inside an authorized root.
- Keep default bare paths on the Desktop while routing `Documents/...` and `Downloads/...` to their natural roots.
- Extend health output, installation messages and integration coverage to all three roots.

## 1.1.0

- Point the default Windows `workspace:/` root at the user's real Desktop so ChatGPT file operations affect the visible Desktop.
- Keep the single-root security boundary and accept `desktop`/`desktop:/` as compatibility aliases for that same authorized root.
- Align the HTTP agent, stdio tunnel entrypoint and Windows scheduled tasks on the Desktop default.
- Add integration coverage for Desktop alias listing and confirmed writes.

## 1.0.0

- Add the ManuMCP Windows agent with authenticated loopback HTTP and MCP stdio transports.
- Add one-workspace tools for health, listing, reading, searching and confirmed text edits.
- Add Windows startup installation, optional ngrok testing and an explicit uninstall script.
- Add integration coverage for HTTP authentication, path boundaries, secret blocking, one-time confirmations and stdio.

## 0.4.0

- Restore the MIT core boundary. This repository is the DIY one-project MCP core: path authorization, text file tools, confirmed writes, protocol framing and HTTP over a Unix socket.
- Remove binary file transfer, resumable upload staging, durable receipts and checkpoint language. Those belong to the TunnelGPT application, not this gift.
- Keep bounded long-line pagination (0.2.0) and the credential-scanner ReDoS fix from 0.3.1.

## 0.3.1

- Fix three CodeQL `js/polynomial-redos` findings in credential assignment scanning. Prefixes, quoted values and comment suffixes are consumed separately, including escaped quotes, without overlapping optional whitespace groups.
- Add a regression for three malformed assignments containing 120,000 spaces.

The transfer and staging APIs that landed beside this fix are withdrawn in 0.4.0.

## 0.2.0

- Read bounded fragments of long UTF-8 lines using Unicode code point columns. Continuations include `nextStartLine` and `nextStartColumn`; consumers must carry both to avoid skipping text. Full-file hashing and identity checks remain in place.
- Long lines outside a requested range no longer prevent reading that range. Credential detection scans overlapping chunks before returning fragments, including credential markers split across a page boundary.
- `.gitignore` no longer authorizes or denies MCP file access. `.mcpignore` remains the explicit exclusion source, and directory exclusions apply to direct descendant reads as well as directory listings. Protected credential paths and root boundaries are unchanged.

Consumers should bind pagination cursors to the returned file hash. A cursor is not permission to continue reading a different version of the file.
