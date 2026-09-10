import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const servers = new Map();
const boards = new Map();
const instanceBoards = new Map();
const boardLocks = new Map();
const histories = new Map();

const nodeSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        type: { enum: ["note", "card", "process", "decision"] },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number", minimum: 120, maximum: 600 },
        height: { type: "number", minimum: 70, maximum: 500 },
        title: { type: "string" },
        content: { type: "string" },
        color: { enum: ["neutral", "blue", "green", "yellow", "red", "purple"] },
    },
    required: ["id", "type", "x", "y", "title"],
};

const edgeSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        label: { type: "string" },
    },
    required: ["id", "from", "to"],
};

function safeId(value) {
    return String(value).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "main";
}

function boardPath(boardId) {
    if (!session.workspacePath) throw new Error("Scratch Pad requires a session workspace.");
    return join(session.workspacePath, ".scratch-pad", `${safeId(boardId)}.json`);
}

function initialBoard(boardId, title = "Scratch Pad") {
    return {
        boardId,
        title,
        revision: 0,
        nodes: [],
        edges: [],
        updatedAt: new Date().toISOString(),
    };
}

async function loadBoard(boardId, title) {
    if (boards.has(boardId)) return boards.get(boardId);
    let board;
    try {
        board = { ...initialBoard(boardId, title), ...JSON.parse(await readFile(boardPath(boardId), "utf8")) };
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        board = initialBoard(boardId, title);
        await saveBoard(board);
    }
    boards.set(boardId, board);
    return board;
}

async function saveBoard(board) {
    const path = boardPath(board.boardId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(board, null, 2)}\n`, "utf8");
    boards.set(board.boardId, board);
}

function broadcast(boardId) {
    const payload = `data: ${JSON.stringify(boards.get(boardId))}\n\n`;
    for (const entry of servers.values()) {
        if (entry.boardId !== boardId) continue;
        for (const client of entry.clients) client.write(payload);
    }
}

async function withBoardLock(boardId, operation) {
    let release;
    const lock = new Promise((resolve) => {
        release = resolve;
    });
    const previous = boardLocks.get(boardId);
    boardLocks.set(boardId, lock);
    if (previous) await previous;
    try {
        return await operation();
    } finally {
        release();
        if (boardLocks.get(boardId) === lock) boardLocks.delete(boardId);
    }
}

async function mutateBoard(boardId, mutate, { recordHistory = true } = {}) {
    return withBoardLock(boardId, async () => {
        const current = structuredClone(await loadBoard(boardId));
        if (recordHistory) {
            const history = histories.get(boardId) ?? { undo: [], redo: [] };
            history.undo.push(current);
            history.undo = history.undo.slice(-50);
            history.redo = [];
            histories.set(boardId, history);
        }
        const next = mutate(current);
        validateBoard(next);
        next.revision = current.revision + 1;
        next.updatedAt = new Date().toISOString();
        await saveBoard(next);
        broadcast(boardId);
        return next;
    });
}

function validateBoard(board) {
    if (board.nodes.length > 500 || board.edges.length > 1000) {
        throw new Error("Board limit exceeded (500 nodes or 1000 edges).");
    }
    const nodeTypes = new Set(["note", "card", "process", "decision"]);
    const colors = new Set(["neutral", "blue", "green", "yellow", "red", "purple"]);
    const nodeIds = new Set();
    for (const node of board.nodes) {
        if (!node.id || nodeIds.has(node.id)) throw new Error(`Duplicate or invalid node ID: ${node.id}`);
        if (!nodeTypes.has(node.type) || !colors.has(node.color ?? "neutral")) {
            throw new Error(`Node ${node.id} has an invalid type or color.`);
        }
        if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || typeof node.title !== "string") {
            throw new Error(`Node ${node.id} has invalid position or text.`);
        }
        if (node.width !== undefined && (!Number.isFinite(node.width) || node.width < 120 || node.width > 600)) {
            throw new Error(`Node ${node.id} has an invalid width.`);
        }
        if (node.height !== undefined && (!Number.isFinite(node.height) || node.height < 70 || node.height > 500)) {
            throw new Error(`Node ${node.id} has an invalid height.`);
        }
        nodeIds.add(node.id);
    }
    const edgeIds = new Set();
    for (const edge of board.edges) {
        if (!edge.id || edgeIds.has(edge.id)) throw new Error(`Duplicate or invalid edge ID: ${edge.id}`);
        if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(`Edge ${edge.id} references a missing node.`);
        edgeIds.add(edge.id);
    }
}

function arrange(board) {
    const incoming = new Map(board.nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(board.nodes.map((node) => [node.id, []]));
    for (const edge of board.edges) {
        incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
        outgoing.get(edge.from)?.push(edge.to);
    }
    const levels = new Map();
    const queue = board.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
    for (const node of board.nodes) if (!queue.includes(node.id) && !board.edges.length) queue.push(node.id);
    while (queue.length) {
        const id = queue.shift();
        const level = levels.get(id) ?? 0;
        for (const child of outgoing.get(id) ?? []) {
            levels.set(child, Math.max(levels.get(child) ?? 0, level + 1));
            incoming.set(child, incoming.get(child) - 1);
            if (incoming.get(child) === 0) queue.push(child);
        }
    }
    for (const node of board.nodes) if (!levels.has(node.id)) levels.set(node.id, 0);
    const rows = new Map();
    for (const node of board.nodes) {
        const level = levels.get(node.id);
        const row = rows.get(level) ?? 0;
        node.x = 80 + level * 300;
        node.y = 80 + row * 180;
        rows.set(level, row + 1);
    }
    return board;
}

async function undoBoard(boardId) {
    return withBoardLock(boardId, async () => {
        const history = histories.get(boardId);
        if (!history?.undo.length) return loadBoard(boardId);
        const current = structuredClone(await loadBoard(boardId));
        history.redo.push(current);
        const previous = history.undo.pop();
        previous.revision = current.revision + 1;
        previous.updatedAt = new Date().toISOString();
        await saveBoard(previous);
        broadcast(boardId);
        return previous;
    });
}

async function redoBoard(boardId) {
    return withBoardLock(boardId, async () => {
        const history = histories.get(boardId);
        if (!history?.redo.length) return loadBoard(boardId);
        const current = structuredClone(await loadBoard(boardId));
        history.undo.push(current);
        const next = history.redo.pop();
        next.revision = current.revision + 1;
        next.updatedAt = new Date().toISOString();
        await saveBoard(next);
        broadcast(boardId);
        return next;
    });
}

async function applyMutation(boardId, input) {
    switch (input.type) {
        case "add":
            return mutateBoard(boardId, (board) => {
                board.nodes.push(...(input.nodes ?? []));
                board.edges.push(...(input.edges ?? []));
                return board;
            });
        case "update":
            return mutateBoard(boardId, (board) => {
                const patches = new Map((input.nodes ?? []).map((node) => [node.id, node]));
                const existingIds = new Set(board.nodes.map((node) => node.id));
                for (const id of patches.keys()) {
                    if (!existingIds.has(id)) throw new Error(`Cannot update missing node: ${id}`);
                }
                board.nodes = board.nodes.map((node) => patches.has(node.id) ? { ...node, ...patches.get(node.id) } : node);
                return board;
            });
        case "remove":
            return mutateBoard(boardId, (board) => {
                const nodeIds = new Set(input.nodeIds ?? []);
                const edgeIds = new Set(input.edgeIds ?? []);
                board.nodes = board.nodes.filter((node) => !nodeIds.has(node.id));
                board.edges = board.edges.filter((edge) =>
                    !edgeIds.has(edge.id) && !nodeIds.has(edge.from) && !nodeIds.has(edge.to));
                return board;
            });
        case "replace":
            return mutateBoard(boardId, (board) => ({
                ...board,
                nodes: input.nodes ?? [],
                edges: input.edges ?? [],
            }));
        case "arrange":
            return mutateBoard(boardId, arrange);
        default:
            throw new Error(`Unsupported mutation type: ${input.type}`);
    }
}

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error("Request body is too large.");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startServer(boardId) {
    const clients = new Set();
    const renderer = await readFile(join(extensionDirectory, "renderer.html"), "utf8");
    const server = createServer(async (req, res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (req.method === "GET" && req.url === "/state") {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(await loadBoard(boardId)));
            return;
        }
        if (req.method === "GET" && req.url === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            clients.add(res);
            res.write(`data: ${JSON.stringify(await loadBoard(boardId))}\n\n`);
            req.on("close", () => clients.delete(res));
            return;
        }
        if (req.method === "POST" && req.url === "/mutate") {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            try {
                const board = await applyMutation(boardId, await readJson(req));
                res.end(JSON.stringify({ revision: board.revision }));
            } catch (error) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }
        if (req.method === "POST" && (req.url === "/undo" || req.url === "/redo")) {
            const board = req.url === "/undo" ? await undoBoard(boardId) : await redoBoard(boardId);
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ revision: board.revision }));
            return;
        }
        if (req.method === "POST" && req.url === "/notify") {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            try {
                const input = await readJson(req);
                await session.send({
                    prompt: `The user updated the shared Scratch Pad "${(await loadBoard(boardId)).title}". `
                        + `User note: ${String(input.message || "Review the latest board changes.")} `
                        + "Read the scratch-pad canvas before responding or changing the board.",
                });
                res.end(JSON.stringify({ notified: true }));
            } catch (error) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderer);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, clients, boardId, url: `http://127.0.0.1:${port}/` };
}

function boardIdFor(ctx) {
    const boardId = instanceBoards.get(ctx.instanceId);
    if (!boardId) throw new Error(`Unknown Scratch Pad instance: ${ctx.instanceId}`);
    return boardId;
}

const session = await joinSession({
    hooks: {
        onSessionStart: async () => ({
            additionalContext: "A shared Scratch Pad canvas is available for visual brainstorming. "
                + "When the user asks to brainstorm visually, open one stable boardId, read_board before editing, "
                + "and use batch operations rather than many tiny updates.",
        }),
    },
    canvases: [
        createCanvas({
            id: "scratch-pad",
            displayName: "Scratch Pad",
            description: "Shared visual whiteboard for user-agent brainstorming with editable nodes and flow connections.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    boardId: { type: "string" },
                    title: { type: "string" },
                },
            },
            actions: [
                {
                    name: "read_board",
                    description: "Read all nodes and edges on the shared whiteboard before editing.",
                    handler: async (ctx) => structuredClone(await loadBoard(boardIdFor(ctx))),
                },
                {
                    name: "add_elements",
                    description: "Add a batch of nodes and optional connecting edges to the whiteboard.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            nodes: { type: "array", items: nodeSchema },
                            edges: { type: "array", items: edgeSchema },
                        },
                    },
                    handler: async (ctx) => {
                        const board = await applyMutation(boardIdFor(ctx), { type: "add", ...ctx.input });
                        return { revision: board.revision, nodeCount: board.nodes.length, edgeCount: board.edges.length };
                    },
                },
                {
                    name: "update_nodes",
                    description: "Update node position, size, text, type, or color. Each patch must include an ID.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            nodes: {
                                type: "array",
                                items: {
                                    type: "object",
                                    additionalProperties: false,
                                    properties: {
                                        id: { type: "string" },
                                        type: { enum: ["note", "card", "process", "decision"] },
                                        x: { type: "number" },
                                        y: { type: "number" },
                                        width: { type: "number" },
                                        height: { type: "number" },
                                        title: { type: "string" },
                                        content: { type: "string" },
                                        color: { enum: ["neutral", "blue", "green", "yellow", "red", "purple"] },
                                    },
                                    required: ["id"],
                                },
                            },
                        },
                        required: ["nodes"],
                    },
                    handler: async (ctx) => {
                        const board = await applyMutation(boardIdFor(ctx), { type: "update", ...ctx.input });
                        return { revision: board.revision, updated: ctx.input.nodes.length };
                    },
                },
                {
                    name: "connect_nodes",
                    description: "Add labeled directional connections between existing nodes.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: { edges: { type: "array", items: edgeSchema } },
                        required: ["edges"],
                    },
                    handler: async (ctx) => {
                        const board = await applyMutation(boardIdFor(ctx), { type: "add", edges: ctx.input.edges });
                        return { revision: board.revision, edgeCount: board.edges.length };
                    },
                },
                {
                    name: "remove_elements",
                    description: "Remove nodes or edges by ID; removing a node also removes its connections.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            nodeIds: { type: "array", items: { type: "string" } },
                            edgeIds: { type: "array", items: { type: "string" } },
                        },
                    },
                    handler: async (ctx) => {
                        const board = await applyMutation(boardIdFor(ctx), { type: "remove", ...ctx.input });
                        return { revision: board.revision, nodeCount: board.nodes.length, edgeCount: board.edges.length };
                    },
                },
                {
                    name: "arrange_board",
                    description: "Automatically arrange nodes into a left-to-right flow based on connections.",
                    handler: async (ctx) => {
                        const board = await applyMutation(boardIdFor(ctx), { type: "arrange" });
                        return { revision: board.revision, arranged: board.nodes.length };
                    },
                },
            ],
            open: async (ctx) => {
                const boardId = ctx.input?.boardId ?? "main";
                const board = await loadBoard(boardId, ctx.input?.title);
                instanceBoards.set(ctx.instanceId, boardId);
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(boardId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: board.title, status: `${board.nodes.length} nodes`, url: entry.url };
            },
            onClose: async (ctx) => {
                instanceBoards.delete(ctx.instanceId);
                const entry = servers.get(ctx.instanceId);
                if (!entry) return;
                servers.delete(ctx.instanceId);
                for (const client of entry.clients) client.end();
                await new Promise((resolve) => entry.server.close(resolve));
            },
        }),
    ],
});
