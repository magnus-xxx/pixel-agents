import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { startStaleExternalAgentCheck } from '../src/fileWatcher.js';
import {
  agentHubProvider,
  formatToolStatus,
  normalizeHookEvent,
  sessionIdentity,
} from '../src/providers/hook/agent-hub/agentHub.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { hookProviders, pushProviders } from '../src/providers/index.js';

describe('agent-hub provider: normalization', () => {
  it('maps the Hub wire events to AgentEvents', () => {
    expect(
      normalizeHookEvent({ hook_event_name: 'SessionStart', session_id: 'hub-leo', cwd: '/p' }),
    ).toEqual({
      sessionId: 'hub-leo',
      event: { kind: 'sessionStart', source: 'agent-hub', cwd: '/p' },
    });
    expect(
      normalizeHookEvent({
        hook_event_name: 'ToolStart',
        session_id: 'hub-leo',
        tool_name: 'Bash',
        status: 'MAG-1 · npm test',
      }),
    ).toEqual({
      sessionId: 'hub-leo',
      event: {
        kind: 'toolStart',
        toolId: '',
        toolName: 'Bash',
        input: { status: 'MAG-1 · npm test' },
      },
    });
    expect(
      normalizeHookEvent({ hook_event_name: 'ToolEnd', session_id: 'hub-leo' })?.event,
    ).toEqual({ kind: 'toolEnd', toolId: '' });
    expect(
      normalizeHookEvent({
        hook_event_name: 'TurnEnd',
        session_id: 'hub-zoe',
        awaiting_input: true,
      })?.event,
    ).toEqual({ kind: 'turnEnd', awaitingInput: true });
    expect(
      normalizeHookEvent({ hook_event_name: 'TurnEnd', session_id: 'hub-zoe' })?.event,
    ).toEqual({ kind: 'turnEnd', awaitingInput: false });
  });

  it('drops unknown events and events without a session', () => {
    expect(normalizeHookEvent({ hook_event_name: 'Nope', session_id: 'hub-leo' })).toBeNull();
    expect(normalizeHookEvent({ hook_event_name: 'ToolEnd' })).toBeNull();
  });

  it('gives each Hub agent a fixed name and palette', () => {
    expect(sessionIdentity('hub-ana')).toEqual({ agentName: 'Ana', palette: 0 });
    expect(sessionIdentity('hub-zoe')).toEqual({ agentName: 'Zoe', palette: 3 });
    expect(sessionIdentity('hub-max')).toEqual({ agentName: 'Max' });
    expect(sessionIdentity('some-claude-session')).toBeUndefined();
  });

  it('shows the Hub status line, truncated', () => {
    expect(formatToolStatus('Bash', { status: 'MAG-1 · npm test' })).toBe('MAG-1 · npm test');
    expect(formatToolStatus('Bash', {})).toBe('Bash');
    expect(formatToolStatus('Bash', { status: 'x'.repeat(500) }).length).toBe(120);
  });

  it('is a push provider only: never part of the consent gate', () => {
    expect(pushProviders).toContain(agentHubProvider);
    expect(hookProviders).not.toContain(agentHubProvider);
  });
});

describe('agent-hub provider: runtime routing', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => runtime?.dispose());

  const untrackedDir = () => path.join(os.tmpdir(), `pxl-hub-test-${crypto.randomUUID()}`);

  function messages(): Array<Record<string, unknown>> {
    const seen: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => seen.push(m));
    return seen;
  }

  it('adopts a Hub agent outside tracked dirs, with its fixed name and palette', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, pushProviders);
    const cwd = untrackedDir();
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'SessionStart',
      session_id: 'hub-leo',
      cwd,
    });
    expect(store.size).toBe(0); // pending until a confirming event, like any external session
    const seen = messages();
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'ToolStart',
      session_id: 'hub-leo',
      tool_name: 'Bash',
      status: 'MAG-7 · chạy lệnh · npm test',
    });
    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent.agentName).toBe('Leo');
    expect(agent.palette).toBe(2);
    expect(agent.hooksOnly).toBe(true);
    expect(agent.projectDir).toBe(cwd);
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'agentToolStart', status: 'MAG-7 · chạy lệnh · npm test' }),
    );
    expect(seen).toContainEqual(expect.objectContaining({ type: 'agentStatus', status: 'active' }));
  });

  it('marks waiting-on-Owner and done from TurnEnd', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, pushProviders);
    const cwd = untrackedDir();
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'SessionStart',
      session_id: 'hub-zoe',
      cwd,
    });
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'TurnEnd',
      session_id: 'hub-zoe',
      awaiting_input: true,
    });
    const agent = [...store.values()][0];
    expect(agent.agentName).toBe('Zoe');
    expect(agent.isWaiting).toBe(true);
  });

  it('keeps one character per Hub agent across repeated session starts', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, pushProviders);
    const cwd = untrackedDir();
    for (let i = 0; i < 3; i += 1) {
      runtime.handleHookEvent('agent-hub', {
        hook_event_name: 'SessionStart',
        session_id: 'hub-ben',
        cwd,
      });
      runtime.handleHookEvent('agent-hub', {
        hook_event_name: 'ToolStart',
        session_id: 'hub-ben',
        tool_name: 'Edit',
      });
      runtime.handleHookEvent('agent-hub', { hook_event_name: 'ToolEnd', session_id: 'hub-ben' });
    }
    expect(store.size).toBe(1);
  });

  it('survives the stale-external sweep with Claude hooks off (no transcript file to stat)', () => {
    vi.useFakeTimers();
    try {
      store = new AgentStateStore();
      runtime = new AgentRuntime(store, claudeProvider, pushProviders);
      const cwd = untrackedDir();
      runtime.handleHookEvent('agent-hub', {
        hook_event_name: 'SessionStart',
        session_id: 'hub-ana',
        cwd,
      });
      runtime.handleHookEvent('agent-hub', { hook_event_name: 'TurnEnd', session_id: 'hub-ana' });
      expect(store.size).toBe(1);
      const sweep = startStaleExternalAgentCheck(store, new Set(), { current: false });
      vi.advanceTimersByTime(120_000);
      clearInterval(sweep);
      expect(store.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps PermissionRequest (waiting on the Owner) to a persistent permission bubble', () => {
    expect(
      normalizeHookEvent({ hook_event_name: 'PermissionRequest', session_id: 'hub-zoe' })?.event,
    ).toEqual({
      kind: 'permissionRequest',
    });
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, pushProviders);
    const seen = messages();
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'SessionStart',
      session_id: 'hub-zoe',
      cwd: untrackedDir(),
    });
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'TurnEnd',
      session_id: 'hub-zoe',
      awaiting_input: true,
    });
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'PermissionRequest',
      session_id: 'hub-zoe',
    });
    expect(seen).toContainEqual(expect.objectContaining({ type: 'agentToolPermission' }));
  });

  it('moves a Hub agent to the new project when its cwd changes (same name, palette, one character)', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, pushProviders);
    const first = untrackedDir();
    const second = untrackedDir();
    const removed: number[] = [];
    store.on('agentRemoved', (id) => removed.push(id));
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'SessionStart',
      session_id: 'hub-leo',
      cwd: first,
    });
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'ToolStart',
      session_id: 'hub-leo',
      tool_name: 'Bash',
    });
    const before = [...store.values()][0];
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'SessionStart',
      session_id: 'hub-leo',
      cwd: second,
    });
    expect(removed).toEqual([before.id]);
    expect(store.size).toBe(1);
    const after = [...store.values()][0];
    expect(after.projectDir).toBe(second);
    expect(after.directoryName).toBe(path.basename(second));
    expect(after.agentName).toBe('Leo');
    expect(after.palette).toBe(2);
    // Later events route to the relocated character.
    const seen = messages();
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'ToolStart',
      session_id: 'hub-leo',
      tool_name: 'Read',
      status: 'OPS-1 · đọc',
    });
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'agentToolStart', id: after.id, status: 'OPS-1 · đọc' }),
    );
    // Same cwd again: no move.
    runtime.handleHookEvent('agent-hub', {
      hook_event_name: 'SessionStart',
      session_id: 'hub-leo',
      cwd: second,
    });
    expect(removed).toHaveLength(1);
  });

  it('a client reconnecting mid-job is replayed the running tool, then nothing once the turn ends', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, pushProviders);
    const cwd = untrackedDir();
    const hub = (raw: Record<string, unknown>) =>
      runtime.handleHookEvent('agent-hub', { session_id: 'hub-ben', ...raw });
    const reconnect = () => {
      const sent: Array<Record<string, unknown>> = [];
      resendAgentActivity((m) => sent.push(m), store);
      return sent;
    };
    hub({ hook_event_name: 'SessionStart', cwd });
    hub({ hook_event_name: 'ToolEnd' });
    hub({ hook_event_name: 'ToolStart', tool_name: 'Hub', status: 'MAG-21 · chạy việc' });
    hub({ hook_event_name: 'ToolEnd' });
    hub({
      hook_event_name: 'ToolStart',
      tool_name: 'write_to_file',
      status: 'MAG-21 · write_to_file · src/App.tsx',
    });
    const id = [...store.values()][0].id;

    // Page reload while the job runs: exactly the current tool, no stale earlier one, not waiting.
    const midJob = reconnect().filter((m) => m.id === id);
    expect(midJob.filter((m) => m.type === 'agentToolStart')).toEqual([
      expect.objectContaining({
        status: 'MAG-21 · write_to_file · src/App.tsx',
        toolName: 'write_to_file',
      }),
    ]);
    expect(midJob.some((m) => m.type === 'agentStatus' && m.status === 'waiting')).toBe(false);

    // Turn ends: reload shows a finished agent, no running tool.
    hub({ hook_event_name: 'ToolEnd' });
    hub({ hook_event_name: 'TurnEnd' });
    const afterTurn = reconnect().filter((m) => m.id === id);
    expect(afterTurn.some((m) => m.type === 'agentToolStart')).toBe(false);
    expect(afterTurn).toContainEqual({ type: 'agentStatus', id, status: 'waiting' });

    // Waiting on the Owner: reload shows the waiting status and the persistent bubble.
    hub({ hook_event_name: 'ToolEnd' });
    hub({ hook_event_name: 'ToolStart', tool_name: 'Hub', status: 'MAG-21 · chạy việc' });
    hub({ hook_event_name: 'ToolEnd' });
    hub({ hook_event_name: 'TurnEnd', awaiting_input: true });
    hub({ hook_event_name: 'PermissionRequest' });
    const waiting = reconnect().filter((m) => m.id === id);
    expect(waiting.some((m) => m.type === 'agentToolStart')).toBe(false);
    expect(waiting.map((m) => m.type)).toEqual([
      'agentTeamInfo',
      'agentStatus',
      'agentToolPermission',
    ]);
  });

  it('leaves Claude routing and its foreign-session gate unchanged', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider, pushProviders);
    const cwd = untrackedDir();
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'c-1',
      source: 'startup',
      cwd,
    });
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 'c-1' });
    expect(store.size).toBe(0);
  });
});
