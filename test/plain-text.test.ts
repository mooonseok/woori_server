import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isPlainText,
  trimText,
} from '../src/common/decorators/plain-text.decorator';

test('plain text counts code points and trims only string input', () => {
  assert.equal(trimText('  a　'), 'a');
  assert.equal(trimText(3), 3);
  assert.ok(isPlainText('😀'.repeat(3), 1, 3, false));
  assert.ok(!isPlainText('😀'.repeat(4), 1, 3, false));
  assert.ok(isPlainText('', 0, 3, false));
  assert.ok(!isPlainText('', 1, 3, false));
  assert.ok(!isPlainText(null, 0, 3, false));
});
test('plain text rejects control, bidi and separator characters by line mode', () => {
  const bidi = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩'];
  for (const ch of [...bidi, '\u0000', '\u0007', '\u007f', '\u0085', '\ud800'])
    for (const multiline of [false, true])
      assert.ok(
        !isPlainText(`a${ch}b`, 1, 10, multiline),
        `${ch.codePointAt(0)!.toString(16)} ${multiline}`
      );
  for (const ch of ['\n', '\r', '\t', ' ', ' ']) {
    assert.ok(
      !isPlainText(`a${ch}b`, 1, 10, false),
      ch.codePointAt(0)!.toString(16)
    );
    assert.ok(
      isPlainText(`a${ch}b`, 1, 10, true),
      ch.codePointAt(0)!.toString(16)
    );
  }
  // Neighbouring formatting characters that are not controls stay allowed.
  for (const ch of ['‍', '‧', ' ', '⁪'])
    assert.ok(
      isPlainText(`a${ch}b`, 1, 10, false),
      ch.codePointAt(0)!.toString(16)
    );
  // A module-level pattern must not keep state between calls.
  assert.ok(!isPlainText('x‮y', 1, 10, true));
  assert.ok(!isPlainText('x‮y', 1, 10, true));
});
