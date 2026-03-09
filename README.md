# OCI Code

OCI Code is a minimal web GUI for coding agents. Currently Codex-first, with Claude Code support coming soon.
OCI Code does not send product telemetry.

## Migration from T3 Code

This release is a clean namespace break. If you are upgrading from T3 Code, rename any `T3CODE_*`
environment variables to `OCICODE_*`, move persisted state from `~/.t3` to `~/.ocicode` if you want
to keep it, and update any scripts or aliases that invoked `t3` so they call `ocicode` instead.

## How to use

> [!WARNING]
> You need to have [Codex CLI](https://github.com/openai/codex) installed and authorized for OCI Code to work.

```bash
npx ocicode
```

You can also just install the desktop app. It's cooler.

Install the [desktop app from the Releases page](https://github.com/ocicode/oci-code/releases)

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

## If you REALLY want to contribute still.... read this first

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
