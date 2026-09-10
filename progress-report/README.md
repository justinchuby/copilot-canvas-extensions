# Progress Report

An interactive engineering brief designed for a CTO or engineering leader.

## What it shows

- Executive summary and overall health
- Portfolio-level workstream progress
- Up to five shipped outcomes and next priorities
- Material risks with owners and mitigations
- Decisions requiring user input
- A compact signal log with task-level detail collapsed by default

## Interaction

Decision cards support approving the recommendation, selecting a proposed
option, entering a custom direction, or deferring to a selected date. Responses
are persisted, moved into decision history, and sent back to the active Copilot
session.

## Agent actions

- `update_report` publishes or partially updates the executive brief.
- `record_event` appends a significant milestone, risk, decision, or scope
  change.

Report state is stored in the owning session workspace under
`.progress-report/<reportId>.json`.

