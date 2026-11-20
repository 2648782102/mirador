# Security policy

Found a vulnerability? Report it privately through
[GitHub Security Advisories](https://github.com/mata-2p/mirador/security/advisories/new).
Please do not open a public issue.

## Reporting

| What | Policy |
|---|---|
| Channel | GitHub Security Advisories, private to the maintainer |
| Acknowledgement | Within 7 days |
| Bug bounty | None |

Include the Mirador version or commit, your platform, the steps to reproduce, and what an attacker gains.

## What the server exposes

Mirador opens real terminals (through node-pty) on your machine, so it guards every way in.

| Guard | What it does |
|---|---|
| Localhost only | The server listens on `127.0.0.1:4545` and nowhere else. |
| Session token | Each window redeems a session token from its launch link; requests without it are refused. |
| Origin and Host checks | Requests whose `Origin` or `Host` header is not Mirador's own are refused. |
| Folder confinement | Every folder Mirador reads, writes or opens a terminal in must sit inside the configured workspace roots. |

## In scope

A bypass of any guard above: a request from another website that the server accepts, a request that works without the
session token, a connection from outside the machine, or a path that escapes the workspace roots.
