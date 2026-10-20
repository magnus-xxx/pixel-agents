/**
 * Agent Hub provider (fork addition): agents run by a local orchestrator — the
 * "Mike's Agents" Hub — that pushes their activity to this server itself.
 *
 * The Hub drives Claude Code and Antigravity agents (Ana, Ben, Leo, Zoe) for
 * several projects and already normalizes their activity into one stream. Its
 * office bridge POSTs that stream here as small, already-sequenced events, so
 * this provider only translates names; it installs nothing and never touches
 * any CLI's settings (installHooks is a no-op).
 *
 * Wire format (POST /api/hooks/agent-hub, Bearer token from the server registry):
 *   { hook_event_name: 'SessionStart', session_id: 'hub-leo', cwd: '<project root>' }
 *   { hook_event_name: 'ToolStart',    session_id, tool_name: 'Bash', status: 'MAG-12 · chạy lệnh · npm test' }
 *   { hook_event_name: 'ToolEnd',      session_id }
 *   { hook_event_name: 'TurnEnd',      session_id, awaiting_input?: true }
 *   { hook_event_name: 'PermissionRequest', session_id }   (waiting on the Owner: persistent bubble)
 *   { hook_event_name: 'SessionEnd',   session_id, reason?: string }
 * One session per Hub agent (`hub-<agentKey>`), so each agent is one character.
 * A SessionStart whose cwd differs from the character's project moves the
 * character to that project's Area (adoptsAllSessions providers only).
 */

import type {
  AgentEvent,
  HookProvider,
  SessionIdentity,
} from '../../../../../core/src/provider.js';

export const AGENT_HUB_PROVIDER_ID = 'agent-hub';
export const AGENT_HUB_SESSION_PREFIX = 'hub-';

/** Fixed character per Hub agent: the label over the head and a stable sheet.
 *  Unknown agent keys get a capitalized label and the diversity assigner.
 *  Ana/Ben/Leo/Zoe use the Hub's own sheets, loaded as an external asset
 *  directory after the 6 bundled ones (char_0..3 there = palettes 6..9). The
 *  webview picks `palette % loadedCount`, so without that directory they fall
 *  back to bundled sheets 0..3 instead of breaking. */
const HUB_AGENTS: Record<string, SessionIdentity> = {
  ana: { agentName: 'Ana', palette: 6 },
  ben: { agentName: 'Ben', palette: 7 },
  leo: { agentName: 'Leo', palette: 8 },
  zoe: { agentName: 'Zoe', palette: 9 },
  owner: { agentName: 'Owner', palette: 4 },
};

const MAX_STATUS = 120;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function sessionIdentity(sessionId: string): SessionIdentity | undefined {
  if (!sessionId.startsWith(AGENT_HUB_SESSION_PREFIX)) return undefined;
  const key = sessionId.slice(AGENT_HUB_SESSION_PREFIX.length).toLowerCase();
  if (!key) return undefined;
  return HUB_AGENTS[key] ?? { agentName: key.charAt(0).toUpperCase() + key.slice(1) };
}

export function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const sessionId = str(raw.session_id);
  if (!sessionId) return null;
  switch (raw.hook_event_name) {
    case 'SessionStart':
      return { sessionId, event: { kind: 'sessionStart', source: 'agent-hub', cwd: str(raw.cwd) } };
    case 'ToolStart':
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: str(raw.tool_id) ?? '',
          toolName: str(raw.tool_name) ?? 'Hub',
          input: { status: str(raw.status) },
        },
      };
    case 'ToolEnd':
      return { sessionId, event: { kind: 'toolEnd', toolId: str(raw.tool_id) ?? '' } };
    case 'TurnEnd':
      return { sessionId, event: { kind: 'turnEnd', awaitingInput: raw.awaiting_input === true } };
    case 'PermissionRequest':
      return { sessionId, event: { kind: 'permissionRequest' } };
    case 'SessionEnd':
      return { sessionId, event: { kind: 'sessionEnd', reason: str(raw.reason) } };
    default:
      return null;
  }
}

/** The Hub already wrote a human status line (job key · what is happening). */
export function formatToolStatus(toolName: string, input?: unknown): string {
  const status = str((input as { status?: unknown } | undefined)?.status);
  const text = status ?? toolName;
  return text.length > MAX_STATUS ? `${text.slice(0, MAX_STATUS - 1)}…` : text;
}

export const agentHubProvider: HookProvider = {
  kind: 'hook',
  id: AGENT_HUB_PROVIDER_ID,
  displayName: 'Agent Hub',
  protocolVersion: 1,

  normalizeHookEvent,

  // The Hub pushes events itself: nothing to install, nothing to undo.
  installHooks: async () => {},
  uninstallHooks: async () => {},
  areHooksInstalled: async () => true,
  consentDisclosure: () => ({
    headline: 'Agent Hub',
    disclosure:
      'The local Agent Hub posts its own agents’ activity to this office. Nothing is installed or changed on this machine.',
  }),

  formatToolStatus,
  // Hub agents never wait on a terminal permission prompt this server could see;
  // waiting on the Owner arrives as an explicit TurnEnd(awaiting_input).
  permissionExemptTools: new Set<string>(),
  subagentToolNames: new Set<string>(),
  readingTools: new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']),

  adoptsAllSessions: true,
  sessionIdentity,
};
