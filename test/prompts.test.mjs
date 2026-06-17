import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntroPublicGuide,
  buildIntroSystemPrompt,
  ensureCompleteIntroContent
} from '../src/prompts.js';

const INTRO_MODULE = {
  schema_version: '1.0',
  module_info: {
    title: '现实的荒原',
    system: 'Call of Cthulhu 7th Edition',
    recommended_players: '1-6名调查员',
    estimated_duration: '8-20小时',
    setting: '2008年次贷危机后的美国。',
    time_period: '2008年末至2009年初',
    location: '美国底特律郊区一座废弃汽车工会大厅。',
    themes: ['经济崩溃', '绝望', '现实缺失'],
    tone: '文学化、压抑、冷幽默。',
    content_warnings: ['经济危机与失业', '精神崩溃']
  },
  player_opening: {
    initial_public_information: '调查员是被现实碾碎的人。一个富有银行家在底特律近郊酒吧给出现金预付款和一张模糊照片。',
    initial_scene_id: 'bar_commission',
    initial_objective: '前往废弃汽车工会大厅，观察空洞，弄清它是什么、是否会扩张、能否填上。',
    suggested_intro_text: '门口风铃响起，炭灰色西装的中年人把厚厚的牛皮纸信封放在你的桌前。',
    known_npcs: ['npc_patron'],
    known_locations: ['bar_commission', 'union_hall_void'],
    known_handouts: ['asset_blurry_void_photo', 'asset_cash_envelope']
  },
  keeper_overview: {
    truth: '委托人是奈亚拉托提普化身。',
    investigation_goal: '回答空洞的三个问题。',
    default_opening: '调查员在底特律近郊酒吧收到委托。'
  },
  scenes: [
    {
      scene_id: 'bar_commission',
      name: '底特律近郊酒吧委托',
      player_visible_description: '即将倒闭的酒吧里，富有银行家用现金信封和模糊照片雇佣绝望中的调查员。'
    },
    {
      scene_id: 'union_hall_void',
      name: '废弃汽车工会大厅与空洞',
      player_visible_description: '主厅中央有直径一米的完美球形空缺。'
    }
  ],
  npcs: [
    {
      npc_id: 'npc_patron',
      name: '富有的银行家',
      role: '委托人，奈亚拉托提普化身'
    }
  ],
  visual_assets: [
    {
      asset_id: 'asset_blurry_void_photo',
      name: '模糊的空洞照片',
      player_visible_description: '照片里有一个完美圆形空缺，像某物被精确切走。'
    },
    {
      asset_id: 'asset_cash_envelope',
      name: '预付款牛皮纸信封',
      player_visible_description: '里面现金大概够调查员生活一周。'
    }
  ],
  checks: [
    { check_id: 'spot_void', skill: '侦查' },
    { check_id: 'listen_hall', skill: '聆听' },
    { check_id: 'read_records', skill: '图书馆使用' }
  ]
};

test('intro prompt requires complete public opening sections', () => {
  const prompt = buildIntroSystemPrompt();
  assert.match(prompt, /不能只写“模组简介”/);
  assert.match(prompt, /## 玩家公开前提/);
  assert.match(prompt, /## 开局场景/);
  assert.match(prompt, /NPC 的 role 字段可能包含隐藏身份/);
});

test('buildIntroPublicGuide extracts public opening without leaking hidden NPC role', () => {
  const guide = buildIntroPublicGuide({ moduleJson: INTRO_MODULE, moduleTitle: '现实的荒原', maxPlayers: 5 });
  assert.match(guide.contextText, /底特律近郊酒吧/);
  assert.match(guide.contextText, /牛皮纸信封/);
  assert.match(guide.contextText, /模糊的空洞照片/);
  assert.match(guide.contextText, /侦查、聆听、图书馆使用/);
  assert.doesNotMatch(guide.contextText, /奈亚拉托提普化身/);
});

test('ensureCompleteIntroContent appends missing opening sections from module JSON', () => {
  const guide = buildIntroPublicGuide({ moduleJson: INTRO_MODULE, moduleTitle: '现实的荒原', maxPlayers: 5 });
  const shortIntro = [
    '## 模组简介',
    '2008年末，底特律正在经济危机中下沉。'
  ].join('\n\n');

  const completed = ensureCompleteIntroContent(shortIntro, guide);
  assert.match(completed, /## 模组简介/);
  assert.match(completed, /## 玩家公开前提/);
  assert.match(completed, /## 调查员创建指南/);
  assert.match(completed, /## 开局场景/);
  assert.match(completed, /前往废弃汽车工会大厅/);
  assert.match(completed, /炭灰色西装/);
  assert.doesNotMatch(completed, /奈亚拉托提普化身/);
});
