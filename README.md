# Copilot Canvas Extensions

Personal collection of Canvas extensions for GitHub Copilot.

## Extensions

| Extension | Purpose | Install |
| --- | --- | --- |
| [Progress Report](progress-report/) | Interactive CTO-style engineering brief for outcomes, risks, decisions, and next steps. | [Install folder](https://github.com/justinchuby/copilot-canvas-extensions/tree/main/progress-report) |

## Layout

```text
.
├── .github/workflows/validate.yml
├── scripts/validate.mjs
└── <extension-name>/
    ├── copilot-extension.json
    ├── extension.mjs
    ├── README.md
    └── assets/                 # Optional renderer assets
```

Each top-level extension directory is independently installable. Keep runtime
wiring in `extension.mjs`; place larger renderers, schemas, and helpers in
sibling files.

## Install

In GitHub Copilot, install an extension from its GitHub folder URL and choose
user, project, or session scope:

```text
https://github.com/justinchuby/copilot-canvas-extensions/tree/main/progress-report
```

## Development

This repository can be cloned directly to `~/.copilot/extensions` for personal
development. Reload extensions after editing, then verify discovery and Canvas
actions from Copilot.

Run the repository checks with:

```bash
node scripts/validate.mjs
```

## Conventions

- One independently installable Canvas per top-level directory.
- Canvas IDs and extension directory names use kebab-case.
- Bind renderer servers to `127.0.0.1` only.
- Persist user data by stable domain ID, never only by Canvas instance ID.
- Use app theme tokens instead of hardcoded presentation styles where possible.
- Never write to stdout from an extension process.

