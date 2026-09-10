# Scratch Pad

A shared visual whiteboard for brainstorming with GitHub Copilot.

## Features

- Editable note, card, process, and decision nodes
- Dragging, panning, zooming, selection, and deletion
- Directional connections between nodes
- Automatic left-to-right flow layout
- Undo and redo for the current extension process
- Persistent board JSON keyed by a stable `boardId`
- Server-Sent Events for live synchronization
- Agent actions for reading and batch-editing the board
- A "Tell agent" control for sending user context back to the session

Board data is stored in the session workspace under
`.scratch-pad/<boardId>.json`. Text is rendered as text rather than arbitrary
HTML to avoid script injection.

## Agent actions

- `read_board`
- `add_elements`
- `update_nodes`
- `connect_nodes`
- `remove_elements`
- `arrange_board`
