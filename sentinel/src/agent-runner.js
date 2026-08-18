// One dimension agent = one query() call with its own model, its own browser
// session, and only the browser tools. Built-in file and shell tools are denied
// on purpose: an agent that can read ledgerly/server.js would "find" every
// defect by reading the source, and the evaluation would measure nothing.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createBrowserServer, BrowserSession } from './tools.js';
import { systemPromptFor, FINDINGS_SCHEMA } from './dimensions.js';
import { REPO_ROOT } from './harness.js';

const BROWSER_TOOLS = [
  'seed_app', 'open_page', 'snapshot', 'click', 'fill', 'select_option', 'press_key', 'go_back',
  'set_viewport', 'inspect_element', 'read_console', 'api_request', 'screenshot', 'check_probe',
].map((t) => `mcp__browser__${t}`);

const DENIED = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'];

// Agents cannot see how much budget they have left, so an early run had four of
// five spend every turn exploring and never write their findings down. This hook
// feeds a countdown back with each tool result and escalates to a hard
// instruction near the end, which converts an exhausted agent into a reporting
// one.
function budgetHook(state, maxTurns) {
  const soft = Math.floor(maxTurns * 0.55);
  const hard = Math.floor(maxTurns * 0.78);
  return async () => {
    state.calls += 1;
    const left = maxTurns - state.calls;
    let note = null;
    if (state.calls >= hard) {
      note = `BUDGET CRITICAL: about ${left} tool calls remain before you are cut off. `
        + `Stop investigating now and return your structured result with what you already have. `
        + `Findings you have seen but not written down are lost.`;
    } else if (state.calls >= soft) {
      note = `Budget check: ${state.calls}/${maxTurns} tool calls used. Start converging — `
        + `confirm what you have and leave room to write up your findings and probes.`;
    }
    return note
      ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } }
      : {};
  };
}

export async function runDimensionAgent(dim, { target, browser, evidence, modelOverride, onEvent }) {
  const recorder = evidence.recorder(`agents/${dim.key}`, { trace: true, video: true });
  const session = new BrowserSession({ harness: target, browser, recorder });
  const model = modelOverride || dim.model;
  const maxTurns = dim.maxTurns ?? 80;
  const budgetState = { calls: 0 };
  const started = Date.now();

  const result = {
    dimension: dim.key, title: dim.title, model,
    findings: [], experienceNotes: [], journeyRatings: [], checkedButHealthy: [], notes: '',
    turns: 0, costUsd: 0, durationMs: 0, toolCalls: 0,
    error: null, evidence: null,
  };

  try {
    const q = query({
      prompt: `Evaluate the ${dim.title} dimension of the application now. Begin by seeding the app, then explore. Return your structured result when done.`,
      options: {
        model,
        systemPrompt: systemPromptFor(dim, { baseUrl: target.baseUrl, maxTurns }),
        mcpServers: { browser: createBrowserServer(session) },
        allowedTools: BROWSER_TOOLS,
        disallowedTools: DENIED,
        maxTurns,
        hooks: { PostToolUse: [{ hooks: [budgetHook(budgetState, maxTurns)] }] },
        permissionMode: 'bypassPermissions',
        settingSources: [],
        cwd: REPO_ROOT,
        outputFormat: { type: 'json_schema', schema: FINDINGS_SCHEMA },
      },
    });

    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            result.toolCalls += 1;
            onEvent?.({ dim: dim.key, kind: 'tool', name: String(block.name).replace('mcp__browser__', '') });
          }
        }
      }
      if (msg.type === 'result') {
        result.turns = msg.num_turns ?? 0;
        result.costUsd = msg.total_cost_usd ?? 0;
        result.modelUsage = msg.modelUsage ?? {};
        if (msg.subtype === 'success') {
          const out = msg.structured_output;
          if (out && typeof out === 'object') {
            result.findings = Array.isArray(out.findings) ? out.findings : [];
            result.checkedButHealthy = Array.isArray(out.checkedButHealthy) ? out.checkedButHealthy : [];
            result.experienceNotes = (Array.isArray(out.experienceNotes) ? out.experienceNotes : [])
              .map((n) => ({ ...n, dimension: dim.key, model }));
            result.journeyRatings = (Array.isArray(out.journeyRatings) ? out.journeyRatings : [])
              .map((r) => ({ ...r, dimension: dim.key }));
            result.notes = out.notes ?? '';
          } else {
            result.error = 'agent returned no structured output';
          }
        } else {
          result.error = `${msg.subtype}${msg.terminal_reason ? ` (${msg.terminal_reason})` : ''}`;
        }
      }
    }
  } catch (err) {
    result.error = String(err?.message ?? err);
  } finally {
    await session.close();
    result.durationMs = Date.now() - started;
    result.evidence = recorder.manifest();
  }

  // Stamp provenance onto every finding so the report can attribute claims.
  result.findings = result.findings.map((f, i) => ({
    ...f, dimension: dim.key, model, localId: `${dim.key}-${i + 1}`,
    agentEvidence: result.evidence,
  }));
  return result;
}
