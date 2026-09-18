import assert from 'node:assert/strict';
import test from 'node:test';

import { createScreenscriptRunRegistry } from '../screenscript-run-registry.js';

test('run registry turns normalized provider events into a labelled live feed', () => {
  const runs = createScreenscriptRunRegistry();
  runs.beginRun({ runId: 'ss2-1', model: 'gpt-5-codex' });
  runs.record('ss2-1', { kind: 'session_created', sessionId: 'session-1' });
  runs.record('ss2-1', { kind: 'tool_use', id: 'item-1', toolName: 'Bash', toolInput: { command: 'ffprobe a.mp4' } });
  runs.record('ss2-1', { kind: 'tool_result', id: 'item-1_result', content: 'ok' });
  runs.record('ss2-1', { kind: 'text', id: 'item-2', role: 'assistant', content: 'готово' });
  runs.record('ss2-1', { kind: 'error', content: 'SCREENSCRIPT_AGENT_FAILED' });
  runs.endRun('ss2-1', { ok: false, errorCode: 'SCREENSCRIPT_AGENT_FAILED' });

  const [snapshot] = runs.listRuns();
  assert.equal(snapshot.runId, 'ss2-1');
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.model, 'gpt-5-codex');
  assert.equal(snapshot.sessionId, 'session-1');
  assert.equal(snapshot.eventCount, 5);
  assert.equal(snapshot.droppedEvents, 0);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.lastLabel, 'error');
  assert.equal(snapshot.errorCode, 'SCREENSCRIPT_AGENT_FAILED');
  assert.ok(snapshot.finishedAt !== null);

  const detail = runs.getRun('ss2-1');
  assert.deepEqual(detail?.events.map((event) => event.label), ['session', 'Bash', 'result', 'assistant', 'error']);
  assert.deepEqual(detail?.events.map((event) => event.isError), [false, false, false, false, true]);
  assert.equal(detail?.events[1].messageId, 'item-1');
  assert.match(JSON.stringify(detail?.events[1].payload), /ffprobe/);
  assert.deepEqual(detail?.events.map((event) => event.seq), [1, 2, 3, 4, 5]);
});

test('run registry keeps only the newest events and says that it dropped older ones', () => {
  const runs = createScreenscriptRunRegistry({ maxEventsPerRun: 3 });
  runs.beginRun({ runId: 'ss2-2' });
  for (let index = 1; index <= 5; index += 1) {
    runs.record('ss2-2', { kind: 'text', id: `m${index}`, content: `строка ${index}` });
  }

  const detail = runs.getRun('ss2-2');
  assert.equal(detail?.events.length, 3);
  assert.deepEqual(detail?.events.map((event) => event.messageId), ['m3', 'm4', 'm5']);
  assert.equal(detail?.run.eventCount, 5);
  assert.equal(detail?.run.droppedEvents, 2);
  assert.equal(detail?.run.truncated, true);
});

test('run registry replaces only the payload of oversized events', () => {
  const runs = createScreenscriptRunRegistry({ maxPayloadChars: 40 });
  runs.beginRun({ runId: 'ss2-3' });
  runs.record('ss2-3', { kind: 'tool_result', content: 'x'.repeat(200), huge: 'y'.repeat(200) });

  const [event] = runs.getRun('ss2-3')?.events ?? [];
  assert.deepEqual(Object.keys(event.payload as object), ['truncated', 'preview']);
  assert.equal((event.payload as { truncated: boolean }).truncated, true);
  assert.ok((event.payload as { preview: string }).preview.length <= 41);
});
test('run registry records writes that pass through its writer and still forwards them', () => {
  const runs = createScreenscriptRunRegistry();
  const forwarded: unknown[] = [];
  const sessions: string[] = [];
  const writer = runs.recordWriter('ss2-4', {
    isSSEStreamWriter: true,
    send(data: unknown) { forwarded.push(data); },
    setSessionId(sessionId: string) { sessions.push(sessionId); },
    end() { forwarded.push('ended'); },
  });
  runs.beginRun({ runId: 'ss2-4' });

  writer.send({ kind: 'text', id: 'm1', content: 'привет' });
  writer.setSessionId?.('session-4');
  writer.end();

  assert.equal(forwarded.length, 2);
  assert.deepEqual(sessions, ['session-4']);
  assert.equal(runs.getRun('ss2-4')?.run.sessionId, 'session-4');
  assert.equal(runs.getRun('ss2-4')?.events.length, 1);
});

test('run registry ignores unknown runs and invalid ids', () => {
  const runs = createScreenscriptRunRegistry();
  runs.beginRun({ runId: 'bad id' });
  runs.record('ss2-missing', { kind: 'text', content: 'никому' });
  assert.deepEqual(runs.listRuns(), []);
  assert.equal(runs.isRunId('bad id'), false);
  assert.equal(runs.isRunId('ss2-ok_1'), true);
  const unsubscribe = runs.subscribe('ss2-missing', () => undefined);
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
});

test('run registry notifies subscribers about events and the end of a run', () => {
  const runs = createScreenscriptRunRegistry();
  runs.beginRun({ runId: 'ss2-5' });
  const seen: string[] = [];
  const unsubscribe = runs.subscribe('ss2-5', (message) => {
    seen.push(message.type === 'event' ? `event:${message.event.label}` : `end:${message.run.status}`);
  });

  runs.record('ss2-5', { kind: 'tool_use', id: 't1', toolName: 'Bash' });
  runs.endRun('ss2-5', { ok: true });
  unsubscribe();
  runs.record('ss2-5', { kind: 'text', id: 'm1', content: 'после отписки' });

  assert.deepEqual(seen, ['event:Bash', 'end:completed']);
});

test('run registry forgets removed runs and evicts the oldest finished ones first', () => {
  const runs = createScreenscriptRunRegistry({ maxRuns: 2 });
  runs.beginRun({ runId: 'ss2-a' });
  runs.endRun('ss2-a', { ok: true });
  runs.beginRun({ runId: 'ss2-b' });
  runs.endRun('ss2-b', { ok: true });
  runs.beginRun({ runId: 'ss2-c' });

  const ids = runs.listRuns().map((snapshot) => snapshot.runId);
  assert.deepEqual(ids, ['ss2-c', 'ss2-b']);

  runs.forgetRun('ss2-c');
  assert.deepEqual(runs.listRuns().map((snapshot) => snapshot.runId), ['ss2-b']);
});
