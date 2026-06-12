import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModuleText, scoreModuleSegment, segmentModuleText, validateModuleFile } from '../src/moduleParser.js';

test('validates TXT module files and extracts segmented text', () => {
  const buffer = Buffer.from('场景：旧宅\n调查员进入旧宅。\n\n场景：阁楼\n阁楼里有脚印。', 'utf8');
  const metadata = validateModuleFile({
    fileName: 'haunted-house.txt',
    contentType: 'text/plain',
    buffer
  });
  const text = extractModuleText({ extension: metadata.extension, buffer });
  const segments = segmentModuleText(text);

  assert.equal(metadata.extension, 'txt');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].title, '场景：旧宅');
  assert.match(segments[1].content, /脚印/);
});

test('scores module segments for retrieval without sending the whole module', () => {
  const segment = { title: '旧宅', scene: '旧宅 #1', content: '壁炉后方藏着地图。' };
  assert.equal(scoreModuleSegment(segment, '我检查壁炉'), 1);
  assert.equal(scoreModuleSegment(segment, '医院 电梯'), 0);
});
