# Security model

What the local server accepts and the limits that remain. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Security

The server can start shells, so it only accepts:

- connections on `127.0.0.1`, with a `Host` header naming that listener (blocks DNS rebinding);
- API calls carrying a session token in an `Authorization` header (WebSockets offer it as a subprotocol). There is no cookie: cookies are shared by every port on `127.0.0.1`, so any local server you visit would receive one;
- a session token obtained only by trading a launch nonce: the launcher reads the launch secret from `$XDG_RUNTIME_DIR/mirador/state.json` (mode 0600, new on every start), asks the server for a nonce, and opens the window at `/#launch=<nonce>`. The nonce works once and expires 60 seconds after the launcher asks for it, so seeing it later in the browser command line or history grants nothing;
- state-changing requests and WebSockets whose `Origin` is the app itself;
- folders (tree, terminals, summaries) that resolve, after symlinks, inside the root of the workspace named in the request.

Every response forbids framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`), so a page on another local port cannot overlay the app. Memory text is rendered with `textContent` only, never as HTML.

Known limits (each needs a process already running as you):

- Attention reports come from the terminal's own processes through the inherited `HERDR_*` variables, so any program in an agent terminal can change what the inbox says about that terminal. The bridge's and gentle-shell's sources always keep their slot, a `seq` far past the clock is refused, and their next report replaces a source someone pushed ahead of the clock, but a process that keeps reporting can still override what they last said.
- Hard links: the editor checks paths after symlinks, but a hard link inside the root to a file outside it reads and saves that file; a path cannot tell a hard link apart.
- Between resolving a file and opening it, a folder in its path could be swapped for a symlink. Reads open the file itself without following a symlink (`O_NOFOLLOW`) and a save resolves the file again just before writing, which narrows that window without closing it.
- A workspace whose root is `/` puts every folder of the machine inside its root guard.
- The runtime folder (`$XDG_RUNTIME_DIR/mirador`, or `~/.cache/mirador` without `XDG_RUNTIME_DIR`) is per user, not per Mirador: every Mirador you start shares it and its herdr socket folder, and any of your processes can read it.
