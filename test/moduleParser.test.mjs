import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModuleText, scoreModuleSegment, segmentModuleText, validateModuleFile } from '../src/moduleParser.js';

const SAMPLE_JSON = JSON.stringify({
  schema_version: '1.0',
  module_info: {
    title: '旧宅调查',
    system: 'Call of Cthulhu 7th Edition',
    time_period: '1920年代',
    location: '城郊旧宅',
    setting: '调查员接到委托前往旧宅调查失踪案件。',
    themes: ['调查', '恐怖'],
    tone: '悬疑'
  },
  keeper_overview: {
    truth: '旧宅主人进行了诡异仪式。',
    investigation_goal: '找到失踪者。',
    default_opening: '调查员抵达旧宅门外。'
  },
  player_opening: {
    initial_public_information: '旧宅荒废已久。',
    initial_objective: '调查失踪案件',
    suggested_intro_text: '推开吱呀作响的木门，霉味扑面而来。'
  },
  scenes: [{
    scene_id: 'old_mansion_hall',
    name: '旧宅大厅',
    type: 'location',
    player_visible_description: '昏暗的大厅，家具被白布覆盖。',
    keeper_secret: '壁炉后方藏有暗格。',
    when_players_enter: '昏暗的大厅中弥漫着霉味。',
    when_players_search: '可以找到隐藏的日记。'
  }],
  npcs: [{
    npc_id: 'old_butler',
    name: '老管家',
    role: '旧宅管家',
    player_visible_info: '面色苍白，沉默寡言。',
    personality: '紧张、回避问题'
  }],
  clues: [{
    clue_id: 'hidden_diary',
    name: '隐藏日记',
    scene_id: 'old_mansion_hall',
    is_core_clue: true,
    reveal_condition: '侦查检定成功',
    player_visible_text: '一本泛黄的日记。'
  }],
  checks: [{
    check_id: 'spot_hidden_01',
    scene_id: 'old_mansion_hall',
    skill: '侦查',
    difficulty: 'regular',
    trigger: '玩家搜索大厅',
    success: '发现暗格',
    failure: '未发现异常'
  }],
  ai_dm_global_rules: {
    role: 'CoC Keeper',
    must_follow: ['不泄露秘密', '不替玩家做决定'],
    style: { narration_length: '2-3 paragraphs', tone: 'suspenseful' }
  },
  endings: [{
    ending_id: 'good',
    name: '真相大白',
    condition: '找到所有线索'
  }]
});

test('validates JSON module files and rejects non-JSON', () => {
  const buffer = Buffer.from(SAMPLE_JSON, 'utf8');
  const metadata = validateModuleFile({
    fileName: 'haunted-house.json',
    contentType: 'application/json',
    buffer
  });
  assert.equal(metadata.extension, 'json');

  // Reject TXT
  assert.throws(
    () => validateModuleFile({
      fileName: 'module.txt',
      contentType: 'text/plain',
      buffer: Buffer.from('hello')
    }),
    (error) => error.message?.includes('Only JSON')
  );

  // Reject PDF
  assert.throws(
    () => validateModuleFile({
      fileName: 'module.pdf',
      contentType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 test')
    }),
    (error) => error.message?.includes('Only JSON')
  );
});

test('rejects invalid JSON with proper error', () => {
  assert.throws(
    () => {
      extractModuleText({ extension: 'json', buffer: Buffer.from('not json', 'utf8') });
    },
    (error) => error.message?.includes('Invalid JSON')
  );

  assert.throws(
    () => {
      extractModuleText({ extension: 'json', buffer: Buffer.from('{}', 'utf8') });
    },
    (error) => error.message?.includes('schema_version')
  );
});

test('extracts and segments JSON module into text segments', () => {
  const buffer = Buffer.from(SAMPLE_JSON, 'utf8');
  const text = extractModuleText({ extension: 'json', buffer });
  const segments = segmentModuleText(text, 'json');

  assert.ok(segments.length > 0);
  // Should have segments for module_info, keeper_overview, player_opening, scene, NPC, clue, check, rules, ending
  assert.ok(segments.some((s) => s.title === '旧宅调查'));
  assert.ok(segments.some((s) => s.title === '守秘人概览'));
  assert.ok(segments.some((s) => s.title === '开场信息'));
  assert.ok(segments.some((s) => s.title === '旧宅大厅'));
  assert.ok(segments.some((s) => s.title === 'NPC: 老管家'));
  assert.ok(segments.some((s) => s.title === '线索: 隐藏日记'));
  assert.ok(segments.some((s) => s.scene === 'rules'));
  assert.ok(segments.some((s) => s.title === '结局: 真相大白'));
});

test('scores JSON module segments for retrieval', () => {
  const segment = { title: '旧宅大厅', scene: 'old_mansion_hall', content: '壁炉后方藏着暗格，需要侦查检定。' };
  assert.equal(scoreModuleSegment(segment, '我检查壁炉'), 1);
  assert.equal(scoreModuleSegment(segment, '医院 电梯'), 0);
});

test('handles empty JSON gracefully', () => {
  const segments = segmentModuleText('{}', 'json');
  assert.equal(segments.length, 0);
});
