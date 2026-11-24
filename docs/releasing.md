# Releasing

For maintainers. A release is a tag, a set of prebuilt Linux archives on a GitHub release, and a promotion PR
that pins that release in `scripts/bootstrap.sh`. Nothing reaches users until all three are done: the
workflow only creates a draft, a maintainer publishes it by hand, and the one-line install keeps installing the
version it pins (or from source, while none is pinned) until the promotion PR is merged.

## What the release workflow builds

`.github/workflows/release.yml` runs on a pushed `v*` tag, or by hand (**Actions › release › Run workflow**).
Its `build` job makes one archive per architecture, each on a GitHub-hosted runner of that architecture:

| Archive | Runner |
|---------|--------|
| `mirador-<version>-linux-x64.tar.gz` | `ubuntu-24.04` |
| `mirador-<version>-linux-arm64.tar.gz` | `ubuntu-24.04-arm` |

Each archive is one folder, `mirador-<version>-linux-<arch>/`, holding:

- Mirador's committed sources as they are (`bin/`, `src/`, `public/`, `docs/`, `package.json`, the lockfile and
  the license files). Nothing is bundled or compiled: the server runs its TypeScript with Node, as from a clone.
- `node/bin/node`, the official Node binary (`NODE_VERSION` in the workflow), fetched from nodejs.org and
  checked against the sha256 pinned beside `NODE_VERSION` for its architecture (`NODE_SHA256_LINUX_X64`,
  `NODE_SHA256_LINUX_ARM64`; `scripts/release/fetch-node.sh`). The `SHASUMS256.txt` nodejs.org serves at
  the same moment is not trusted: whoever could swap the tarball could swap it too. `bin/mirador` runs the
  bundled Node before any Node on `PATH` or from mise.
- `node_modules` with the lockfile's production dependencies, installed with no install scripts. `node-pty` is
  then built from its sources inside an AlmaLinux 8 container (`BUILD_IMAGE`, glibc 2.28, Node 24's own minimum),
  so the archive runs on any Linux with glibc 2.28 or newer. The build checks that the addon needs no newer
  glibc and that, in that container, the bundled Node loads it, opens a terminal with it and runs esbuild
  (`scripts/release/build-linux.sh`, `scripts/release/build-in-container.sh`,
  `scripts/release/check-glibc.sh`). The other platforms' prebuilds are left out.

The `smoke` job then checks each archive on a runner of its architecture (`scripts/release/smoke.sh`). It
unpacks the archive in clean containers, with no Node, pnpm or compiler and no network: the bare
`BUILD_IMAGE` (AlmaLinux 8, glibc 2.28, the oldest glibc supported) and `CURRENT_IMAGE` (Debian 13), both
pinned by digest. In each it runs the archive's doctor, starts the server with `bin/mirador`, checks that it
answers the page, the one-time link's session and the API, and stops it
(`scripts/release/smoke-in-container.sh`). The job summary shows each archive's size and, per container, how
long the unpack, the doctor and the server start took. The same script runs locally, with docker, on an
archive that `build-linux.sh` wrote:

```sh
sh scripts/release/smoke.sh dist/mirador-0.2.0-linux-x64.tar.gz "$BUILD_IMAGE" "$CURRENT_IMAGE"
```

The `publish` job waits for both builds, both smoke checks and the approval of the `release` environment.
Then it writes `SHA256SUMS`, attests the build provenance of each archive, and creates a **draft** release
with the archives, `SHA256SUMS` and, in its notes, the lines the promotion PR pins. It never publishes the
release.

The `build` and `smoke` jobs can only read the repository and use no secrets; only `publish` can write
releases and attestations.

## Before the first release

- Create the `release` environment (**Settings › Environments**) with the owner as required reviewer, and limit
  its deployments to tags matching `v*`. Do this before any tag is pushed: a job that names an environment
  that does not exist creates it, with no reviewer.
- Decide whether to turn on immutable releases (**Settings › General › Releases**). Once a release is published
  they lock its assets and its tag, so an archive whose sha256 is pinned in `scripts/bootstrap.sh` can never be
  swapped. A mistake in a published release then needs a new version number. Drafts can still be edited.

## Cutting a release

1. In a PR to main, set the new version in `package.json` and turn the `Unreleased` section of `CHANGELOG.md`
   into that version's section. Merge it.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.2.0 <merge-commit>
   git push origin v0.2.0
   ```

   The workflow stops at once if the tag is not `v<major>.<minor>.<patch>`, optionally with a pre-release
   suffix such as `-rc.1`, or differs from `package.json`
   (`scripts/release/check-tag.sh`). To run it by hand instead, pick the tag under **Use workflow from** and
   give the same tag as input.
3. When both builds and both smoke checks pass, read the smoke job's summary (sizes and timings), then
   approve the `publish` job of the `release` environment.

## Reviewing the draft

On the draft release (**Releases**), before publishing it:

1. Download both archives and `SHA256SUMS` into an empty folder, and check them:

   ```sh
   sha256sum -c SHA256SUMS
   gh attestation verify mirador-0.2.0-linux-x64.tar.gz -R mata-2p/mirador
   gh attestation verify mirador-0.2.0-linux-arm64.tar.gz -R mata-2p/mirador
   ```

2. The smoke job already unpacked each archive in clean containers (the oldest glibc supported and a
   current distribution), ran its doctor and started its server. To try one by hand as well, unpack it on a
   clean Linux system with no Node, pnpm or compiler and run `node/bin/node src/doctor.ts`, then
   `bin/mirador`.
3. The first release with archives is shown to the owner as a draft, before anyone publishes it.
4. Publish it: **Edit › Publish release**.

## Release candidates

A release candidate (`0.2.0-rc.1`) goes through the same steps, with three differences:

- The workflow creates its draft as a pre-release, because the tag has a pre-release suffix, so the releases
  page keeps the last stable release as **Latest**. Before publishing, check that **Set as a pre-release** is
  ticked. The flag stays editable after publishing.
- With immutable releases on, a published candidate's tag and assets cannot change and its tag name cannot be
  used again, even after the release is deleted: a fix ships as the next candidate (`-rc.2`).
- No promotion PR: `scripts/bootstrap.sh` in main never pins a candidate. To try the install end to end, run a
  local copy of `bootstrap.sh` whose three pin lines carry the candidate's version and sums, in a clean
  container, as an ordinary user with a scratch home.

## The promotion PR

Once the release is published, a PR to main pins it in `scripts/bootstrap.sh`: it replaces the three pin
lines at the top of `main`

```sh
  MIRADOR_VERSION=""
  MIRADOR_SHA256_LINUX_X64=""
  MIRADOR_SHA256_LINUX_ARM64=""
```

with the lines in the release notes (`scripts/release/pins.sh` prints them from `SHA256SUMS`), and changes
nothing else. Check each sha256 against the published `SHA256SUMS`. Leaving a platform's sha256 empty keeps
that platform on the install from source. From the merge on, `curl … bootstrap.sh | sh` installs that release
on Linux x64 and arm64.

The checksum the installer trusts comes from this reviewed change to main, not from the release that serves the
archive: someone who could replace an archive on the release still could not make the installer accept it.

## Updates and Node security releases

The one-line install checks for no updates, and Mirador makes no update check either. Users update by running
the line again, which adds the pinned version beside the ones they have and points `current` at it.

The archives bundle Node, so a Node security release means a Mirador release. Upgrading Node is changing
three lines of `.github/workflows/release.yml` together, in a reviewed PR: `NODE_VERSION` and the two sums
beside it, `NODE_SHA256_LINUX_X64` and `NODE_SHA256_LINUX_ARM64`. A build whose tarball does not match its
pinned sum stops before building anything.

Read the two sums from that version's `SHASUMS256.txt`, and check its signature with the Node.js release keys
first, in an empty folder and a scratch keyring:

```sh
v=24.22.3   # the new NODE_VERSION
curl -fsSLO "https://nodejs.org/dist/v$v/SHASUMS256.txt"
curl -fsSLO "https://nodejs.org/dist/v$v/SHASUMS256.txt.sig"
export GNUPGHOME="$(mktemp -d)"
# The fingerprints listed under "Release keys" in https://github.com/nodejs/node#release-keys:
gpg --keyserver hkps://keys.openpgp.org --recv-keys <fingerprint> ...
gpg --verify SHASUMS256.txt.sig SHASUMS256.txt
grep -E 'linux-(x64|arm64)\.tar\.xz$' SHASUMS256.txt
```

`gpg --verify` must say `Good signature` from a key whose fingerprint is in that list (the warning that the
key is not certified is expected in a scratch keyring). The `linux-x64` line's sum goes in
`NODE_SHA256_LINUX_X64`, the `linux-arm64` line's in `NODE_SHA256_LINUX_ARM64`. Then cut a patch release and
promote it as above.
