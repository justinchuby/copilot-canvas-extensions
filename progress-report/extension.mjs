import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const servers = new Map();
const reports = new Map();
const instanceReports = new Map();
const reportLocks = new Map();

const taskSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        title: { type: "string" },
        status: { enum: ["pending", "in_progress", "done", "blocked"] },
        detail: { type: "string" },
    },
    required: ["id", "title", "status"],
};

const workstreamSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        name: { type: "string" },
        status: { enum: ["on_track", "at_risk", "blocked", "done"] },
        progress: { type: "integer", minimum: 0, maximum: 100 },
        outcome: { type: "string" },
        next: { type: "string" },
        owner: { type: "string" },
    },
    required: ["id", "name", "status"],
};

const riskSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        title: { type: "string" },
        severity: { enum: ["low", "medium", "high", "critical"] },
        owner: { type: "string" },
        mitigation: { type: "string" },
    },
    required: ["id", "title", "severity"],
};

const decisionSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        id: { type: "string" },
        title: { type: "string" },
        recommendation: { type: "string" },
        dueDate: { type: "string" },
        options: { type: "array", items: { type: "string" }, maxItems: 5 },
    },
    required: ["id", "title"],
};

function safeId(value) {
    return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "main";
}

function reportPath(reportId) {
    if (!session.workspacePath) {
        throw new Error("Progress Report requires a session workspace.");
    }
    return join(session.workspacePath, ".progress-report", `${safeId(reportId)}.json`);
}

function initialReport(reportId, input = {}) {
    return {
        reportId,
        title: input.title ?? "Engineering brief",
        summary: input.summary ?? "No executive summary has been published yet.",
        status: input.status ?? "in_progress",
        percent: input.percent ?? 0,
        tasks: input.tasks ?? [],
        workstreams: input.workstreams ?? [],
        wins: input.wins ?? [],
        next: input.next ?? [],
        risks: input.risks ?? [],
        decisions: input.decisions ?? [],
        resolvedDecisions: [],
        events: [],
        updatedAt: new Date().toISOString(),
    };
}

async function loadReport(reportId, input) {
    if (reports.has(reportId)) return reports.get(reportId);
    let report;
    try {
        report = { ...initialReport(reportId), ...JSON.parse(await readFile(reportPath(reportId), "utf8")) };
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        report = initialReport(reportId, input);
        await saveReport(report);
    }
    reports.set(reportId, report);
    return report;
}

async function saveReport(report) {
    const path = reportPath(report.reportId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    reports.set(report.reportId, report);
}

async function mutateReport(reportId, mutate) {
    let release;
    const lock = new Promise((resolve) => {
        release = resolve;
    });
    const previous = reportLocks.get(reportId);
    reportLocks.set(reportId, lock);
    if (previous) await previous;
    try {
        const current = structuredClone(await loadReport(reportId));
        const next = mutate(current);
        next.updatedAt = new Date().toISOString();
        await saveReport(next);
        broadcast(reportId);
        return next;
    } finally {
        release();
        if (reportLocks.get(reportId) === lock) reportLocks.delete(reportId);
    }
}

function derivedPercent(tasks) {
    if (!tasks.length) return 0;
    const weights = { pending: 0, in_progress: 0.5, blocked: 0, done: 1 };
    return Math.round(tasks.reduce((sum, task) => sum + weights[task.status], 0) / tasks.length * 100);
}

function broadcast(reportId) {
    const payload = `data: ${JSON.stringify(reports.get(reportId))}\n\n`;
    for (const entry of servers.values()) {
        if (entry.reportId !== reportId) continue;
        for (const client of entry.clients) client.write(payload);
    }
}

function renderHtml() {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Engineering Brief</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 12px; background: var(--background-color-default, #fff);
      color: var(--text-color-default, #1f2328);
      font: var(--text-body-small, 13px)/18px
        var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    }
    main { max-width: 1180px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; gap: 12px; align-items: start; margin-bottom: 9px; }
    h1 { margin: 0 0 2px; font-size: var(--text-title-medium, 20px); line-height: 1.2; }
    h2 { margin: 0 0 7px; font-size: var(--text-body-medium, 14px); }
    p { margin: 0; color: var(--text-color-muted, #656d76); }
    .eyebrow { color: var(--text-color-muted, #656d76); font-size: 10px; letter-spacing: .07em; text-transform: uppercase; }
    .pill { padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .in_progress { color: var(--true-color-blue, #0969da); background: var(--true-color-blue-muted, #ddf4ff); }
    .done { color: #1a7f37; background: #dafbe1; }
    .blocked { color: var(--true-color-red, #cf222e); background: var(--true-color-red-muted, #ffebe9); }
    .pending { color: var(--text-color-muted, #656d76); background: var(--border-color-default, #d0d7de); }
    .card { border: 1px solid var(--border-color-default, #d0d7de); border-radius: 8px; padding: 10px; }
    .hero { margin-bottom: 8px; background: color-mix(in srgb, var(--true-color-blue-muted, #ddf4ff) 35%, transparent); }
    .hero p { color: var(--text-color-default, #1f2328); font-size: 14px; line-height: 1.35; }
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
    .stat { padding: 7px 9px; }
    .stat strong { display: inline; float: right; margin-left: 6px; font-size: 16px; }
    .stat.alert strong { color: var(--true-color-red, #cf222e); }
    .grid { display: grid; grid-template-columns: 1.5fr 1fr; gap: 8px; align-items: start; }
    .stack { display: grid; gap: 8px; }
    .stream { padding: 7px 0; border-top: 1px solid var(--border-color-default, #d8dee4); }
    .stream:first-of-type { padding-top: 0; border-top: 0; }
    .stream-head { display: flex; justify-content: space-between; gap: 12px; }
    .stream-meta, small, time { color: var(--text-color-muted, #656d76); }
    .tag { font-size: 10px; font-weight: 600; text-transform: uppercase; }
    .on_track { color: #1a7f37; } .at_risk { color: #9a6700; } .critical, .high { color: var(--true-color-red, #cf222e); }
    .bar { height: 4px; margin: 4px 0; overflow: hidden; border-radius: 99px; background: var(--border-color-default, #d0d7de); }
    .bar > div { height: 100%; border-radius: inherit; background: var(--true-color-blue, #0969da); transition: width .35s ease; }
    .list { margin: 0; padding-left: 19px; }
    .list li { margin: 3px 0; }
    .signal { padding: 6px 0; border-top: 1px solid var(--border-color-default, #d8dee4); }
    .signal:first-of-type { padding-top: 0; border-top: 0; }
    .signal b { display: block; }
    .signal .meta { color: var(--text-color-muted, #656d76); margin-top: 3px; }
    .decision-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    button, textarea, input {
      color: var(--text-color-default, #1f2328); background: var(--background-color-default, #fff);
      border: 1px solid var(--border-color-default, #d0d7de); border-radius: 6px; font: inherit;
    }
    button { padding: 4px 7px; cursor: pointer; font-size: 11px; font-weight: 600; }
    button:hover { border-color: var(--true-color-blue, #0969da); }
    button.primary { color: var(--color-white, #fff); background: var(--true-color-blue, #0969da); border-color: transparent; }
    textarea { width: 100%; min-height: 38px; margin-top: 5px; padding: 5px; resize: vertical; }
    input[type="date"] { padding: 3px 5px; font-size: 11px; }
    .feedback { min-height: 12px; margin-top: 3px; font-size: 11px; color: var(--text-color-muted, #656d76); }
    .event { padding: 3px 0; }
    details { margin-top: 7px; border-top: 1px solid var(--border-color-default, #d8dee4); padding-top: 6px; }
    summary { cursor: pointer; color: var(--text-color-muted, #656d76); }
    .task-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 5px 0; border-top: 1px solid var(--border-color-default, #d8dee4); }
    .empty { padding: 6px 0; color: var(--text-color-muted, #656d76); }
    @media (max-width: 760px) {
      body { padding: 9px; } .grid { grid-template-columns: 1fr; } .stats { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div><div class="eyebrow">Engineering brief · <span id="updated"></span></div><h1 id="title">Engineering brief</h1></div>
    <span id="status" class="pill"></span>
  </header>
  <section class="card hero"><div class="eyebrow">Executive summary</div><p id="summary"></p></section>
  <section class="stats">
    <div class="card stat"><span>Overall</span><strong id="percent">0%</strong></div>
    <div class="card stat"><span>Workstreams</span><strong id="streamCount">0</strong></div>
    <div class="card stat alert"><span>Risks</span><strong id="riskCount">0</strong></div>
    <div class="card stat"><span>Decisions</span><strong id="decisionCount">0</strong></div>
  </section>
  <div class="grid">
    <div class="stack">
      <section class="card"><h2>Portfolio pulse</h2><div id="workstreams"></div></section>
      <section class="card"><h2>Outcomes shipped</h2><div id="wins"></div></section>
      <section class="card"><h2>Next horizon</h2><div id="next"></div></section>
    </div>
    <div class="stack">
      <section class="card"><h2>Needs attention</h2><div id="risks"></div></section>
      <section class="card"><h2>Decisions required</h2><div id="decisions"></div><details><summary id="decisionHistorySummary"></summary><div id="decisionHistory"></div></details></section>
      <section class="card"><h2>Signal log</h2><div id="events"></div><details><summary id="eventSummary"></summary><div id="eventArchive"></div></details></section>
    </div>
  </div>
  <details class="card"><summary id="taskSummary">Operational detail</summary><div id="tasks"></div></details>
</main>
<script>
const labels = { pending: "Pending", in_progress: "In progress", done: "Done", blocked: "Blocked", on_track: "On track", at_risk: "At risk" };
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
const empty = message => '<div class="empty">' + message + '</div>';
const renderList = (items, message) => items.length
  ? '<ul class="list">' + items.slice(0, 5).map(item => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul>'
  : empty(message);
function render(report) {
  report.workstreams ||= []; report.wins ||= []; report.next ||= []; report.risks ||= []; report.decisions ||= [];
  report.resolvedDecisions ||= [];
  report.tasks ||= []; report.events ||= [];
  document.getElementById("title").textContent = report.title;
  document.getElementById("summary").textContent = report.summary;
  document.getElementById("updated").textContent = new Date(report.updatedAt).toLocaleString();
  const status = document.getElementById("status");
  status.className = "pill " + report.status;
  status.textContent = labels[report.status] ?? report.status;
  document.getElementById("percent").textContent = report.percent + "%";
  document.getElementById("streamCount").textContent = report.workstreams.length;
  document.getElementById("riskCount").textContent = report.risks.length;
  document.getElementById("decisionCount").textContent = report.decisions.length;
  document.getElementById("workstreams").innerHTML = report.workstreams.length ? report.workstreams.map(stream =>
    '<div class="stream"><div class="stream-head"><b>' + escapeHtml(stream.name) + '</b><span class="tag ' +
    stream.status + '">' + (labels[stream.status] ?? stream.status) + '</span></div><div class="bar"><div style="width:' +
    (stream.progress ?? 0) + '%"></div></div><div>' + escapeHtml(stream.outcome || "") + '</div><div class="stream-meta">' +
    (stream.next ? 'Next: ' + escapeHtml(stream.next) : '') + (stream.owner ? ' · ' + escapeHtml(stream.owner) : '') + '</div></div>'
  ).join("") : empty("No portfolio summary yet");
  document.getElementById("wins").innerHTML = renderList(report.wins, "No outcomes reported");
  document.getElementById("next").innerHTML = renderList(report.next, "No next steps reported");
  document.getElementById("risks").innerHTML = report.risks.length ? report.risks
    .sort((a, b) => ({critical:4,high:3,medium:2,low:1}[b.severity] - {critical:4,high:3,medium:2,low:1}[a.severity]))
    .slice(0, 5).map(risk => '<div class="signal"><span class="tag ' + risk.severity + '">' + risk.severity +
    '</span><b>' + escapeHtml(risk.title) + '</b><div class="meta">' + escapeHtml(risk.mitigation || "No mitigation recorded") +
    (risk.owner ? ' · ' + escapeHtml(risk.owner) : '') + '</div></div>').join("") : empty("No material risks");
  document.getElementById("decisions").innerHTML = report.decisions.length ? report.decisions.slice(0, 5).map(decision =>
    '<div class="signal decision" data-id="' + escapeHtml(decision.id) + '"><b>' + escapeHtml(decision.title) +
    '</b><div>' + escapeHtml(decision.recommendation || "") + '</div><div class="meta">' +
    (decision.dueDate ? 'By ' + escapeHtml(decision.dueDate) : "No deadline") + '</div>' +
    (decision.options?.length ? '<div class="decision-actions">' + decision.options.map(option =>
      '<button data-action="option" data-value="' + escapeHtml(option) + '">' + escapeHtml(option) + '</button>').join("") + '</div>' : '') +
    '<textarea aria-label="Decision direction" placeholder="Add conditions or enter a different direction"></textarea>' +
    '<div class="decision-actions"><button class="primary" data-action="approve">Approve recommendation</button>' +
    '<button data-action="custom">Submit direction</button><input type="date" aria-label="Defer until">' +
    '<button data-action="defer">Defer</button></div><div class="feedback"></div></div>'
  ).join("") : empty("No decisions required");
  document.getElementById("decisionHistorySummary").textContent = report.resolvedDecisions.length
    ? report.resolvedDecisions.length + " resolved decisions" : "No resolved decisions";
  document.getElementById("decisionHistory").innerHTML = [...report.resolvedDecisions].reverse().map(decision =>
    '<div class="signal"><b>' + escapeHtml(decision.title) + '</b><div>' + escapeHtml(decision.response) +
    '</div><div class="meta">' + escapeHtml(decision.outcome) + ' · ' + new Date(decision.respondedAt).toLocaleString() + '</div></div>'
  ).join("");
  const events = [...report.events].reverse();
  const eventHtml = event => '<div class="event"><div>' + escapeHtml(event.message) + '</div><time>' +
    new Date(event.at).toLocaleString() + '</time></div>';
  document.getElementById("events").innerHTML = events.length ? events.slice(0, 5).map(eventHtml).join("") : empty("No significant updates");
  document.getElementById("eventSummary").textContent = events.length > 5 ? "Show " + (events.length - 5) + " earlier updates" : "No earlier updates";
  document.getElementById("eventArchive").innerHTML = events.slice(5).map(eventHtml).join("");
  const counts = report.tasks.reduce((result, task) => ((result[task.status] = (result[task.status] || 0) + 1), result), {});
  document.getElementById("taskSummary").textContent = "Operational detail · " + report.tasks.length + " tasks · " +
    (counts.done || 0) + " done · " + (counts.in_progress || 0) + " active · " + (counts.blocked || 0) + " blocked";
  const visibleTasks = report.tasks.filter(task => task.status === "blocked" || task.status === "in_progress")
    .concat(report.tasks.filter(task => task.status !== "blocked" && task.status !== "in_progress"));
  document.getElementById("tasks").innerHTML = visibleTasks.length ? visibleTasks.map(task =>
    '<div class="task-row"><div><b>' + escapeHtml(task.title) + '</b><small>' + escapeHtml(task.detail || "") +
    '</small></div><span class="tag ' + task.status + '">' + labels[task.status] + '</span></div>'
  ).join("") : empty("No task-level detail");
}
document.getElementById("decisions").addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".decision");
  const action = button.dataset.action;
  const comment = action === "option" ? button.dataset.value : card.querySelector("textarea").value.trim();
  const deferUntil = card.querySelector('input[type="date"]').value;
  const feedback = card.querySelector(".feedback");
  if (action === "custom" && !comment) {
    feedback.textContent = "Enter a direction first.";
    return;
  }
  if (action === "defer" && !deferUntil) {
    feedback.textContent = "Choose a defer date first.";
    return;
  }
  feedback.textContent = "Submitting…";
  for (const control of card.querySelectorAll("button, textarea, input")) control.disabled = true;
  try {
    const response = await fetch("/decisions/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisionId: card.dataset.id, action, comment, deferUntil }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to submit decision");
  } catch (error) {
    feedback.textContent = error.message;
    for (const control of card.querySelectorAll("button, textarea, input")) control.disabled = false;
  }
});
fetch("/state").then(response => response.json()).then(render);
new EventSource("/events").onmessage = event => render(JSON.parse(event.data));
</script>
</body>
</html>`;
}

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error("Request body is too large.");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function respondToDecision(reportId, input) {
    const allowedActions = new Set(["approve", "custom", "option", "defer"]);
    if (typeof input?.decisionId !== "string" || !allowedActions.has(input.action)) {
        throw new Error("Invalid decision response.");
    }
    if ((input.action === "custom" || input.action === "option") && !input.comment?.trim()) {
        throw new Error("A decision direction is required.");
    }
    if (input.action === "defer" && !input.deferUntil) {
        throw new Error("A defer date is required.");
    }

    let resolved;
    await mutateReport(reportId, (current) => {
        const index = current.decisions.findIndex((decision) => decision.id === input.decisionId);
        if (index < 0) throw new Error("Decision is no longer pending.");
        const [decision] = current.decisions.splice(index, 1);
        const response = input.action === "approve"
            ? decision.recommendation || "Recommendation approved"
            : input.action === "defer"
                ? `Deferred until ${input.deferUntil}`
                : input.comment.trim();
        const outcomes = { approve: "Approved", custom: "Direction provided", option: "Option selected", defer: "Deferred" };
        resolved = {
            ...decision,
            outcome: outcomes[input.action],
            response,
            comment: input.comment?.trim() || "",
            deferUntil: input.deferUntil || "",
            respondedAt: new Date().toISOString(),
        };
        current.resolvedDecisions ||= [];
        current.resolvedDecisions.push(resolved);
        current.resolvedDecisions = current.resolvedDecisions.slice(-100);
        current.events.push({
            message: `Decision: ${decision.title} — ${resolved.outcome}: ${response}`,
            at: resolved.respondedAt,
        });
        current.events = current.events.slice(-100);
        return current;
    });

    try {
        await session.send({
            prompt: `The user responded to the engineering brief decision "${resolved.title}". `
                + `Outcome: ${resolved.outcome}. Direction: ${resolved.response}. `
                + "Acknowledge the decision and apply it to the current work when relevant.",
        });
        return { decisionId: input.decisionId, outcome: resolved.outcome, agentNotified: true };
    } catch (error) {
        await session.log(`Decision saved, but the agent notification failed: ${error.message}`, { level: "warning" });
        return {
            decisionId: input.decisionId,
            outcome: resolved.outcome,
            agentNotified: false,
            warning: "Decision saved, but the current agent could not be notified.",
        };
    }
}

async function startServer(instanceId, reportId) {
    const clients = new Set();
    const server = createServer(async (req, res) => {
        if (req.url === "/state") {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify(reports.get(reportId)));
            return;
        }
        if (req.url === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            clients.add(res);
            res.write(`data: ${JSON.stringify(reports.get(reportId))}\n\n`);
            req.on("close", () => clients.delete(res));
            return;
        }
        if (req.method === "POST" && req.url === "/decisions/respond") {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            try {
                const result = await respondToDecision(reportId, await readJson(req));
                res.end(JSON.stringify(result));
            } catch (error) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: error.message }));
            }
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, clients, reportId, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "progress-report",
            displayName: "Progress Report",
            description: "Executive engineering brief showing outcomes, portfolio health, risks, decisions, and next steps.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    reportId: { type: "string", description: "Stable report identifier within this session." },
                    title: { type: "string" },
                    summary: { type: "string" },
                    status: { enum: ["pending", "in_progress", "done", "blocked"] },
                    percent: { type: "integer", minimum: 0, maximum: 100 },
                    tasks: { type: "array", items: taskSchema },
                    workstreams: { type: "array", items: workstreamSchema },
                    wins: { type: "array", items: { type: "string" }, maxItems: 5 },
                    next: { type: "array", items: { type: "string" }, maxItems: 5 },
                    risks: { type: "array", items: riskSchema },
                    decisions: { type: "array", items: decisionSchema },
                },
            },
            actions: [
                {
                    name: "update_report",
                    description: "Publish a concise executive brief; prefer workstream summaries and top-five lists over task dumps.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            title: { type: "string" },
                            summary: { type: "string" },
                            status: { enum: ["pending", "in_progress", "done", "blocked"] },
                            percent: { type: "integer", minimum: 0, maximum: 100 },
                            tasks: { type: "array", items: taskSchema },
                            workstreams: { type: "array", items: workstreamSchema },
                            wins: { type: "array", items: { type: "string" }, maxItems: 5 },
                            next: { type: "array", items: { type: "string" }, maxItems: 5 },
                            risks: { type: "array", items: riskSchema },
                            decisions: { type: "array", items: decisionSchema },
                        },
                    },
                    handler: async (ctx) => {
                        const reportId = instanceReports.get(ctx.instanceId);
                        if (!reportId) throw new Error(`Unknown progress report instance: ${ctx.instanceId}`);
                        const next = await mutateReport(reportId, (current) => {
                            const updated = { ...current, ...ctx.input };
                            if (ctx.input.tasks && ctx.input.percent === undefined) {
                                updated.percent = derivedPercent(updated.tasks);
                            }
                            return updated;
                        });
                        return { reportId, percent: next.percent, status: next.status, updatedAt: next.updatedAt };
                    },
                },
                {
                    name: "record_event",
                    description: "Record only a significant outcome, scope change, risk, decision, or milestone; routine task churn belongs in tasks.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: { message: { type: "string", minLength: 1 } },
                        required: ["message"],
                    },
                    handler: async (ctx) => {
                        const reportId = instanceReports.get(ctx.instanceId);
                        if (!reportId) throw new Error(`Unknown progress report instance: ${ctx.instanceId}`);
                        const report = await mutateReport(reportId, (current) => {
                            current.events.push({ message: ctx.input.message, at: new Date().toISOString() });
                            current.events = current.events.slice(-100);
                            return current;
                        });
                        return { reportId, eventCount: report.events.length, updatedAt: report.updatedAt };
                    },
                },
            ],
            open: async (ctx) => {
                const reportId = ctx.input?.reportId ?? "main";
                await loadReport(reportId, ctx.input);
                instanceReports.set(ctx.instanceId, reportId);
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(ctx.instanceId, reportId);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: reports.get(reportId).title, status: "Live", url: entry.url };
            },
            onClose: async (ctx) => {
                instanceReports.delete(ctx.instanceId);
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    for (const client of entry.clients) client.end();
                    await new Promise((resolve) => entry.server.close(resolve));
                }
            },
        }),
    ],
});
