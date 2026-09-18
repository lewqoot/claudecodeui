import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  formatRunClock,
  mergeRunEvent,
  pickDefaultRunId,
  stringifyRunPayload,
  tailEvents,
  type ScreenscriptRunEvent,
  type ScreenscriptRunSnapshot,
} from '@/modules/settings/tabs/agents-settings/sections/content/screenscriptRuns';

function event(overrides: Partial<ScreenscriptRunEvent> = {}): ScreenscriptRunEvent {
  return {
    seq: 1,
    at: 0,
    kind: 'text',
    messageId: null,
    label: 'assistant',
    text: '',
    isError: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ScreenscriptRunSnapshot> = {}): ScreenscriptRunSnapshot {
  return {
    runId: 'ss2-1',
    status: 'running',
    startedAt: 0,
    updatedAt: 0,
    finishedAt: null,
    sessionId: null,
    model: null,
    eventCount: 0,
    droppedEvents: 0,
    lastLabel: null,
    errorCode: null,
    truncated: false,
    ...overrides,
  };
}

test('mergeRunEvent appends events that have no provider row id', () => {
  const first = event({ seq: 1, messageId: null, text: 'раз' });
  const second = event({ seq: 2, messageId: null, text: 'два' });
  assert.deepEqual(mergeRunEvent([first], second), [first, second]);
});

test('mergeRunEvent replaces the row Codex is updating in place', () => {
  const running = event({ seq: 1, messageId: 'item-1', kind: 'tool_use', label: 'Bash', text: 'ls' });
  const finished = event({ seq: 2, messageId: 'item-1', kind: 'tool_result', label: 'Bash', text: 'готово' });
  const other = event({ seq: 3, messageId: 'item-2', label: 'assistant', text: 'дальше' });

  const merged = mergeRunEvent([running, other], finished);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].label, 'Bash');
  assert.equal(merged[0].text, 'готово');
  assert.equal(merged[1].messageId, 'item-2');
});

test('pickDefaultRunId prefers a run that is still working', () => {
  const finished = snapshot({ runId: 'ss2-old', status: 'completed', startedAt: 10 });
  const running = snapshot({ runId: 'ss2-live', status: 'running', startedAt: 5 });
  assert.equal(pickDefaultRunId([finished, running]), 'ss2-live');
  assert.equal(pickDefaultRunId([finished]), 'ss2-old');
  assert.equal(pickDefaultRunId([]), null);
});

test('tailEvents keeps only the newest events of a long turn', () => {
  const events = Array.from({ length: 10 }, (_value, index) => event({ seq: index + 1 }));
  assert.deepEqual(tailEvents(events, 3).map((item) => item.seq), [8, 9, 10]);
  assert.equal(tailEvents(events, 50).length, 10);
});

test('formatRunClock renders a zero-padded local time', () => {
  const at = new Date(2026, 8, 18, 7, 4, 9).getTime();
  assert.equal(formatRunClock(at), '07:04:09');
});

test('stringifyRunPayload survives values JSON cannot serialize', () => {
  const circular: Record<string, unknown> = { name: 'run' };
  circular.self = circular;
  assert.equal(stringifyRunPayload(circular), '');
  assert.match(stringifyRunPayload({ kind: 'text', text: 'привет' }), /"text": "привет"/);
});
