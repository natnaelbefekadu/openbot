# OpenBot — personal fork

Upstream: <https://github.com/nightly-labs/openbot> (PolyForm Noncommercial 1.0.0)
Fork: <https://github.com/natnaelbefekadu/openbot>
Base release: **v0.65.0**

This fork exists to carry a small set of quality-of-life changes on top of the
published releases. It is not a general-purpose fork: no feature branches, no
upstream PRs, no divergence in the wire protocol.

## Layout

| Ref | Meaning |
| --- | --- |
| `main` | A pristine snapshot of one upstream release tag. Never edited by hand. |
| `local` | `main` + the patch series in `fork-patches/`. This is what gets built. |
| `fork-patches/*.patch` | One `git format-patch` file per change. Ordered, self-contained. |

History is shallow: one commit per release tag, fetched with `--depth=1`. There is
no shared ancestry with upstream, which is why syncs replay patches with `git am`
instead of rebasing.

## Adding a change

```sh
git checkout local
# edit
git commit -am "area: what and why"
rm -f fork-patches/*.patch
git format-patch --no-signature -o fork-patches main..local
```

One commit per concern, so a patch can be dropped by deleting its file in `fork-patches/`.

## Syncing to a new release

```sh
git checkout local && ./scripts/local/sync.sh v0.66.0   # or with no tag = latest
```

That fetches the tag shallow, resets `main` to it, rebuilds `local` from `main`,
replays every patch, then runs `bun install && bun run dist:linux`. If a patch
conflicts, it stops and tells you how to continue.

Take a release only when you want it — nothing in this repo pulls upstream on its
own. Holding at an older tag is the normal way to skip a release.

## What this fork must never change

- **`appId`, `productName`, `artifactName`.** They determine the config and data
  paths (`~/.config/OpenBot`, `~/OpenBot/Agents`). Changing them gives the fork a
  fresh profile and hides every agent, thread and memory from the stock install.
- **The account and Signal services** (`api.openbot.run`, `signal.openbot.run`) and
  anything in `remote/`, `apps/auth-api` or the team/signal protocol packages.
  The phone app signs in through those and gets a ticket to reach this computer.
  Self-hosting them breaks the store phone app against this host.
- **`packages/contracts/src/team-protocol/` and `signal-protocol/`.** Those define
  the frames and capability names the phone negotiates. UI, copy, limits and
  defaults are safe; wire formats are not.

## Updates

The fork build publishes to `natnaelbefekadu/openbot`, so `app-update.yml` points
at the fork's own releases. Automatic download is off by default
(`src/main/update-preference-store.ts`). Bump the version and publish a release on
the fork when you want the in-app updater to offer it; otherwise build and install
the AppImage by hand.

## License

PolyForm Noncommercial 1.0.0. Forking and modifying is allowed for personal,
noncommercial use. Keep `LICENSE` and `NOTICE` intact, and do not use a build of
this for commercial work or distribute it without carrying those files and the
Required Notice along.
