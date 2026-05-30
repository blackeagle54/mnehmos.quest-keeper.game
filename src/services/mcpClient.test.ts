/**
 * Characterization tests for McpClient — the sidecar bridge (src/services/mcpClient.ts).
 *
 * This is the app's ONLY connection to the engine: every frontend tool call
 * funnels through `McpClient.callTool` -> `sendRequest` -> the spawned MCP
 * server's stdio. These tests LOCK IN the current behavior of that bridge; they
 * are not aspirational. If one fails, the bridge contract changed.
 *
 * The load-bearing contracts pinned here:
 *   1. Spawn strategy fallback (sidecar -> direct -> cmd wrapper).
 *   2. JSON-RPC framing in `handleOutput`: newline-delimited assembly, id-routing,
 *      and partial/multi-line chunk reassembly via the messageBuffer.
 *   3. `callTool` RESOLVES on a success response and REJECTS when the engine
 *      returns a JSON-RPC `error` — the whole frontend relies on this rejection.
 *   4. Per-op timeouts: a request with no response rejects after the mapped
 *      timeout (default 30s vs COMPLEX_OPERATIONS 120s), driven by fake timers.
 *   5. Lifecycle: connect / disconnect / isConnected, and that a call before
 *      connect throws 'McpClient not connected'.
 *
 * --- Mocking strategy ---------------------------------------------------------
 * We reuse the purpose-built harness in src/test/mocks/tauriApis.ts
 * (createMockSidecarProcess) to model the stdout/stderr/write/kill surface and
 * its emitStdout/emitStderr helpers. The REAL @tauri-apps/plugin-shell `Command`
 * (returned by Command.sidecar / Command.create) both extends an EventEmitter
 * (`.on('close'|'error')`) AND owns `.stdout`/`.stderr` emitters plus `.spawn()`;
 * the resolved `Child` owns `.write`/`.kill`. The harness process matches the
 * stdout/stderr/write/kill shape, so we wrap it into a command-like object that
 * additionally carries a top-level `on` (close/error) and a `spawn()` resolving
 * to that same object. `mcpClient.ts` registers all listeners on the Command and
 * then reads write/kill off the spawn() result, so a single combined object is a
 * faithful stand-in. Nothing here spawns a real process or touches disk.
 *
 * Mocks are declared before importing the module under test; mcpClient's lazy
 * dynamic imports (@tauri-apps/api/path, @tauri-apps/plugin-fs) resolve to the
 * no-op mocks below so CWD setup / native-module copy / logToFile never hit disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockSidecarProcess, type MockSidecarProcess } from '../test/mocks/tauriApis';

// --- Command factory state ---------------------------------------------------
// A single mutable "command" object models whichever strategy is exercised. The
// `behavior` switch lets a test force sidecar.spawn() to reject so we can assert
// the fallback to Command.create('rpg-mcp-server-direct').

interface MockCommand extends MockSidecarProcess {
  on: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
}

function createMockCommand(): MockCommand {
  const proc = createMockSidecarProcess();
  const cmd = proc as MockCommand;
  // Top-level EventEmitter surface for 'close' / 'error' (Command extends EventEmitter).
  cmd.on = vi.fn();
  // spawn() resolves to the same object so write/kill route to the harness process.
  cmd.spawn = vi.fn(async () => proc);
  return cmd;
}

// Tracks every command produced this test so assertions can target the right one.
const spawnedCommands: MockCommand[] = [];

// Per-strategy controls. Each returns a command (or throws) when invoked.
const sidecarImpl = vi.fn((_name: string, _args?: string[], _opts?: unknown): MockCommand => {
  const cmd = createMockCommand();
  spawnedCommands.push(cmd);
  return cmd;
});

const createImpl = vi.fn((_name: string, _args?: string[], _opts?: unknown): MockCommand => {
  const cmd = createMockCommand();
  spawnedCommands.push(cmd);
  return cmd;
});

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    sidecar: (...args: [string, string[]?, unknown?]) => sidecarImpl(...args),
    create: (...args: [string, string[]?, unknown?]) => createImpl(...args),
  },
}));

// Lazy-imported in connect()/logToFile() — resolve to no-op so no disk/CWD work.
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/mock/app/data'),
  resolveResource: vi.fn(async (p: string) => `/mock/resource/${p}`),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: vi.fn(async () => {}),
  writeTextFile: vi.fn(async () => {}),
  readTextFile: vi.fn(async () => ''),
  copyFile: vi.fn(async () => {}),
}));

// Import AFTER mocks are registered so the bridge binds to them.
import { McpClient } from './mcpClient';

// --- Helpers -----------------------------------------------------------------

/** The Command object backing the active connection (strategy-1 by default). */
function activeCommand(): MockCommand {
  return spawnedCommands[spawnedCommands.length - 1];
}

/**
 * Connect a client and return both it and the backing command. `connect()`
 * awaits a chain of lazy dynamic imports + the spawn; awaiting it is enough.
 */
async function connectedClient(name = 'rpg-mcp-server') {
  const client = new McpClient(name);
  await client.connect();
  return { client, cmd: activeCommand() };
}

/** Build a well-formed JSON-RPC success line (newline-terminated). */
function rpcResult(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

/** Build a well-formed JSON-RPC error line (newline-terminated). */
function rpcError(id: string | number, error: { code: number; message: string; data?: unknown }): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n';
}

/**
 * Pull the JSON-RPC id off the most recent write() to the process. `sendRequest`
 * generates a uuid internally; tests learn it by reading what was written so they
 * can route a matching response back. Returns the parsed request payload.
 */
function lastWrittenRequest(cmd: MockCommand): { id: string; method: string; params?: any } {
  const calls = cmd.write.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const raw = calls[calls.length - 1][0] as string;
  // Each frame is JSON + '\n'.
  return JSON.parse(raw.trim());
}

beforeEach(() => {
  spawnedCommands.length = 0;
  sidecarImpl.mockClear();
  createImpl.mockClear();
  // Default sidecar behavior: succeed. Individual tests override as needed.
  sidecarImpl.mockImplementation((_name, _args, _opts) => {
    const cmd = createMockCommand();
    spawnedCommands.push(cmd);
    return cmd;
  });
  createImpl.mockImplementation((_name, _args, _opts) => {
    const cmd = createMockCommand();
    spawnedCommands.push(cmd);
    return cmd;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// =============================================================================
// 1. Spawn strategies
// =============================================================================

describe('McpClient — spawn strategies', () => {
  it('strategy 1 (Command.sidecar) succeeds and marks the client connected', async () => {
    const { client, cmd } = await connectedClient('rpg-mcp-server');

    // Strategy 1 used the sidecar factory with the server name; strategy 2/3 untouched.
    expect(sidecarImpl).toHaveBeenCalledTimes(1);
    expect(sidecarImpl).toHaveBeenCalledWith('rpg-mcp-server', [], expect.anything());
    expect(createImpl).not.toHaveBeenCalled();

    // The Command got the full listener set wired (close/error on the command;
    // data on stdout/stderr) before spawn.
    expect(cmd.on).toHaveBeenCalledWith('close', expect.any(Function));
    expect(cmd.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(cmd.stdout.on).toHaveBeenCalledWith('data', expect.any(Function));
    expect(cmd.stderr.on).toHaveBeenCalledWith('data', expect.any(Function));
    expect(cmd.spawn).toHaveBeenCalledTimes(1);

    // _isConnected is true after strategy 1; isInitialized is still false, so the
    // composite isConnected() is false until initialize() runs.
    expect(client.isConnected()).toBe(false);
  });

  it('falls back to strategy 2 (Command.create direct) when strategy 1 spawn rejects', async () => {
    // Make the sidecar command spawn() reject, leaving Command.create as the path.
    sidecarImpl.mockImplementationOnce((_name, _args, _opts) => {
      const cmd = createMockCommand();
      cmd.spawn = vi.fn(async () => {
        throw new Error('sidecar binary not found');
      });
      spawnedCommands.push(cmd);
      return cmd;
    });

    const client = new McpClient('rpg-mcp-server');
    await client.connect();

    // Strategy 1 attempted (sidecar), then strategy 2 took over with the direct name.
    expect(sidecarImpl).toHaveBeenCalledTimes(1);
    expect(createImpl).toHaveBeenCalledTimes(1);
    expect(createImpl).toHaveBeenCalledWith('rpg-mcp-server-direct', [], expect.anything());

    // The connection rides the strategy-2 command (the last one pushed).
    const directCmd = activeCommand();
    expect(directCmd.spawn).toHaveBeenCalledTimes(1);
    // Bridge is connected (transport up) but not yet initialized.
    expect(client.isConnected()).toBe(false);

    // Sanity: a request now writes to the strategy-2 command, proving the live
    // process is the direct one rather than the failed sidecar. This request is
    // never answered, so swallow its eventual real-timer timeout rejection —
    // otherwise it surfaces ~10s later as an unhandled rejection in a later test.
    client.listTools().catch(() => { /* unanswered here; ignore late timeout */ });
    await Promise.resolve();
    expect(directCmd.write).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 2. JSON-RPC framing (handleOutput)
// =============================================================================

describe('McpClient — JSON-RPC framing', () => {
  it('routes a single-line response back to the matching pending request by id', async () => {
    const { client, cmd } = await connectedClient();

    const pending = client.listTools();
    await Promise.resolve(); // let the write() microtask settle
    const req = lastWrittenRequest(cmd);
    expect(req.method).toBe('tools/list');

    // Engine answers on stdout with the same id.
    cmd.emitStdout(rpcResult(req.id, { tools: ['a', 'b'] }));

    await expect(pending).resolves.toEqual({ tools: ['a', 'b'] });
    expect(client.getPendingCount()).toBe(0);
  });

  it('reassembles a response split across multiple stdout chunks (partial framing)', async () => {
    const { client, cmd } = await connectedClient();

    const pending = client.callTool('get_thing', { x: 1 });
    await Promise.resolve();
    const req = lastWrittenRequest(cmd);

    const full = rpcResult(req.id, { ok: true, value: 42 }); // JSON + '\n'
    // Split mid-JSON across three writes; no newline until the final chunk.
    const a = full.slice(0, 10);
    const b = full.slice(10, 25);
    const c = full.slice(25);

    cmd.emitStdout(a);
    cmd.emitStdout(b);
    // Still incomplete — no newline yet, so nothing should have resolved.
    expect(client.getPendingCount()).toBe(1);
    cmd.emitStdout(c);

    await expect(pending).resolves.toEqual({ ok: true, value: 42 });
    expect(client.getPendingCount()).toBe(0);
  });

  it('handles several newline-delimited JSON-RPC frames arriving in one chunk and routes each by id', async () => {
    const { client, cmd } = await connectedClient();

    const p1 = client.callTool('tool_one', {});
    await Promise.resolve();
    const r1 = lastWrittenRequest(cmd);

    const p2 = client.callTool('tool_two', {});
    await Promise.resolve();
    const r2 = lastWrittenRequest(cmd);

    expect(client.getPendingCount()).toBe(2);

    // Two complete JSON-RPC frames glued together arrive in a single stdout
    // emission (out of request order, to prove id-routing not arrival-order).
    // NOTE: every frame here starts with '{' — see the known-bug test below for
    // what happens when a non-JSON log line is glued in front of a frame.
    const blob = rpcResult(r2.id, { from: 'two' }) + rpcResult(r1.id, { from: 'one' });
    cmd.emitStdout(blob);

    await expect(p1).resolves.toEqual({ from: 'one' });
    await expect(p2).resolves.toEqual({ from: 'two' });
    expect(client.getPendingCount()).toBe(0);
  });

  it('skips a standalone non-JSON log line on stdout without disturbing a later frame', async () => {
    const { client, cmd } = await connectedClient();

    const pending = client.listTools();
    await Promise.resolve();
    const req = lastWrittenRequest(cmd);

    // A bracketed server-log line arriving in its OWN chunk is ignored (the MCP
    // protocol layer only acts on '{'-prefixed JSON-RPC frames).
    cmd.emitStdout('[server] booting subsystems\n');
    expect(client.getPendingCount()).toBe(1);

    // The real response, in a separate chunk, still routes through correctly.
    cmd.emitStdout(rpcResult(req.id, { tools: ['x'] }));
    await expect(pending).resolves.toEqual({ tools: ['x'] });
  });

  /**
   * REGRESSION GUARD (was a real bug, fixed in this PR): in handleOutput the
   * `while (newlineIndex !== -1)` loop used to refresh `newlineIndex` only at the
   * END of the body. The non-JSON-line branch does a bare `continue`, which
   * SKIPPED that refresh — so the next iteration sliced the (already-advanced)
   * buffer at a STALE offset, truncating and corrupting any JSON-RPC frame glued
   * behind a non-'{' line in the SAME stdout chunk. Such a response was silently
   * dropped and its caller hung until the per-op timeout.
   *
   * Fix: refresh `newlineIndex` immediately after the buffer is advanced, so every
   * exit path (including the `continue`) re-enters the loop with a correct offset.
   * This test pins the corrected behavior: the glued frame routes normally.
   */
  it('routes a frame glued behind a non-JSON line in one chunk (regression guard)', async () => {
    const { client, cmd } = await connectedClient();

    const pending = client.listTools();
    await Promise.resolve();
    const req = lastWrittenRequest(cmd);

    // Log line + JSON-RPC response in a SINGLE stdout chunk. The non-JSON line must
    // not corrupt the slice of the frame that follows it in the same chunk.
    cmd.emitStdout('[server] log line\n' + rpcResult(req.id, { tools: ['y'] }));

    // Race against a short timer (rather than the real 10s listTools timeout) so a
    // regression fails FAST as STILL_PENDING instead of hanging the suite.
    const outcome = await Promise.race([
      pending.then(() => 'RESOLVED'),
      new Promise<string>((r) => setTimeout(() => r('STILL_PENDING'), 20)),
    ]);
    expect(outcome).toBe('RESOLVED');
    await expect(pending).resolves.toEqual({ tools: ['y'] });
    expect(client.getPendingCount()).toBe(0);
  });

  it('ignores responses whose id does not match any pending request', async () => {
    const { client, cmd } = await connectedClient();

    const pending = client.listTools();
    await Promise.resolve();
    const req = lastWrittenRequest(cmd);

    // A stray response for an unknown id must not disturb the real pending one.
    cmd.emitStdout(rpcResult('not-a-real-id', { junk: true }));
    expect(client.getPendingCount()).toBe(1);

    // The correct response still resolves normally.
    cmd.emitStdout(rpcResult(req.id, { tools: [] }));
    await expect(pending).resolves.toEqual({ tools: [] });
  });
});

// =============================================================================
// 3. callTool — resolve on success, REJECT on JSON-RPC error
// =============================================================================

describe('McpClient — callTool contract', () => {
  it('sends a tools/call request and resolves with result on a success response', async () => {
    const { client, cmd } = await connectedClient();

    const pending = client.callTool('roll_dice', { sides: 20 });
    await Promise.resolve();

    const req = lastWrittenRequest(cmd);
    // The frame is a proper JSON-RPC tools/call with name + arguments.
    expect(req.method).toBe('tools/call');
    expect(req.params).toEqual({ name: 'roll_dice', arguments: { sides: 20 } });

    cmd.emitStdout(rpcResult(req.id, { content: [{ type: 'text', text: 'rolled 17' }] }));

    await expect(pending).resolves.toEqual({
      content: [{ type: 'text', text: 'rolled 17' }],
    });
  });

  it('REJECTS when the engine returns a JSON-RPC error (the contract the frontend relies on)', async () => {
    const { client, cmd } = await connectedClient();

    const pending = client.callTool('explode', {});
    await Promise.resolve();
    const req = lastWrittenRequest(cmd);

    // Engine responds with an `error` member instead of `result`.
    cmd.emitStdout(rpcError(req.id, { code: -32000, message: 'Tool failed: bad input' }));

    // callTool must reject — frontend error handling depends on this. The
    // rejection value is the raw JSON-RPC error object (code/message/data).
    await expect(pending).rejects.toMatchObject({
      code: -32000,
      message: 'Tool failed: bad input',
    });
    // Pending entry is cleared either way.
    expect(client.getPendingCount()).toBe(0);
  });

  it('callToolsBatch swallows a per-call rejection into an { error } entry while siblings resolve', async () => {
    const { client, cmd } = await connectedClient();

    const batch = client.callToolsBatch([
      { name: 'ok_tool', args: { a: 1 } },
      { name: 'bad_tool', args: { b: 2 } },
    ]);
    await Promise.resolve();

    // Two writes -> two pending requests; correlate by params.name.
    const writes = cmd.write.mock.calls.map((c) => JSON.parse((c[0] as string).trim()));
    const okReq = writes.find((w) => w.params?.name === 'ok_tool');
    const badReq = writes.find((w) => w.params?.name === 'bad_tool');
    expect(okReq && badReq).toBeTruthy();

    cmd.emitStdout(rpcResult(okReq.id, { done: true }));
    cmd.emitStdout(rpcError(badReq.id, { code: -32001, message: 'nope' }));

    // Batch never rejects; the failed call is captured as { error: <message> }.
    await expect(batch).resolves.toEqual([{ done: true }, { error: 'nope' }]);
  });
});

// =============================================================================
// 4. Timeouts (fake timers)
// =============================================================================

describe('McpClient — request timeouts', () => {
  it('rejects a never-answered default-timeout request after 30s', async () => {
    vi.useFakeTimers();
    const client = new McpClient('rpg-mcp-server');
    await client.connect();
    const cmd = activeCommand();

    // listTools maps to the 10s listTools timeout; use callTool for the 30s default.
    const pending = client.callTool('some_plain_tool', {});
    // Surface the rejection now so the unhandled-rejection guard does not fire
    // before we advance timers.
    const settled = pending.then(
      () => ({ ok: true }),
      (err: Error) => ({ ok: false, err })
    );
    await Promise.resolve();
    expect(client.getPendingCount()).toBe(1);

    // Just before the default 30s deadline: still pending.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.getPendingCount()).toBe(1);

    // Cross the 30s boundary: the request rejects and is evicted.
    await vi.advanceTimersByTimeAsync(2);
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect((outcome as { err: Error }).err.message).toMatch(/timed out after 30000ms/);
    expect(client.getPendingCount()).toBe(0);
    void cmd; // referenced for symmetry; not needed for the assertion
  });

  it('uses the extended 120s timeout for a COMPLEX_OPERATIONS tool (world_manage)', async () => {
    vi.useFakeTimers();
    const client = new McpClient('rpg-mcp-server');
    await client.connect();

    const pending = client.callTool('world_manage', { action: 'generate' });
    const settled = pending.then(
      () => ({ ok: true }),
      (err: Error) => ({ ok: false, err })
    );
    await Promise.resolve();

    // At 31s a default-timeout tool would already be dead; world_manage must NOT
    // have timed out, proving the COMPLEX_OPERATIONS 120s mapping is in force.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(client.getPendingCount()).toBe(1);

    // Just past 120s it finally rejects with the extended deadline in the message.
    await vi.advanceTimersByTimeAsync(90_000);
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect((outcome as { err: Error }).err.message).toMatch(/timed out after 120000ms/);
    expect(client.getPendingCount()).toBe(0);
  });

  it('a response that arrives before the deadline cancels the timeout (no late rejection)', async () => {
    vi.useFakeTimers();
    const client = new McpClient('rpg-mcp-server');
    await client.connect();
    const cmd = activeCommand();

    const pending = client.callTool('quick_tool', {});
    await Promise.resolve();
    const req = lastWrittenRequest(cmd);

    // Answer at 5s, well inside the 30s window.
    await vi.advanceTimersByTimeAsync(5_000);
    cmd.emitStdout(rpcResult(req.id, { value: 'early' }));
    await expect(pending).resolves.toEqual({ value: 'early' });

    // Advancing past the original deadline must not produce a late rejection or
    // re-touch the (already-removed) pending entry.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getPendingCount()).toBe(0);
  });
});

// =============================================================================
// 5. Lifecycle: connect / disconnect / isConnected
// =============================================================================

describe('McpClient — lifecycle', () => {
  it('a tool call before connect() throws "McpClient not connected"', async () => {
    const client = new McpClient('rpg-mcp-server');
    // No connect() -> no process -> sendRequest guard fires.
    await expect(client.callTool('anything', {})).rejects.toThrow('McpClient not connected');
  });

  it('isConnected() is false pre-connect, false after connect-only, true after initialize', async () => {
    const { client, cmd } = await connectedClient();

    // Transport up but uninitialized -> composite still false.
    expect(client.isConnected()).toBe(false);

    // Drive initialize(): it sends an `initialize` request; answer it so the
    // promise resolves and isInitialized flips true.
    const initPromise = client.initialize();
    await Promise.resolve();
    const req = lastWrittenRequest(cmd);
    expect(req.method).toBe('initialize');
    cmd.emitStdout(rpcResult(req.id, { capabilities: {} }));
    await initPromise;

    expect(client.isConnected()).toBe(true);
  });

  it('connect() is idempotent — a second call while connected does not re-spawn', async () => {
    const { client } = await connectedClient();
    expect(sidecarImpl).toHaveBeenCalledTimes(1);

    await client.connect();
    // Already connected -> early return, no new spawn attempt.
    expect(sidecarImpl).toHaveBeenCalledTimes(1);
  });

  it('disconnect() kills the process, clears pending requests, and resets connection state', async () => {
    const { client, cmd } = await connectedClient();

    // Bring it fully online so isConnected() reads true before teardown.
    const initPromise = client.initialize();
    await Promise.resolve();
    const initReq = lastWrittenRequest(cmd);
    cmd.emitStdout(rpcResult(initReq.id, {}));
    await initPromise;
    expect(client.isConnected()).toBe(true);

    // Queue an in-flight request; disconnect must resolve it via cleanup() with a
    // 'Server disconnected' JSON-RPC error, which sendRequest turns into a reject.
    const inflight = client.callTool('slow_tool', {});
    const settled = inflight.then(
      () => ({ ok: true }),
      (err: { message?: string }) => ({ ok: false, err })
    );
    await Promise.resolve();
    expect(client.getPendingCount()).toBe(1);

    await client.disconnect();

    expect(cmd.kill).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
    expect(client.getPendingCount()).toBe(0);

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect((outcome as { err: { message?: string } }).err.message).toBe('Server disconnected');
  });
});
