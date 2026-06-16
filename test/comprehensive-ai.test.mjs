// 综合测试：使用完整 JSON 模组验证所有 AI 检测路径和结构化事件处理
// 运行：node --test test/comprehensive-ai.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createDatabase } from '../src/db.js';
import { enhanceStructuredEvents, extractStructuredEvents, validateStructuredEvents } from '../src/aiOutput.js';
import { getCheckTarget, normalizeCharacterSheet } from '../src/character.js';
import { createEventApplier } from '../src/aiEvents.js';

// ============================================================
// 加载测试模组
// ============================================================
const MODULE_JSON = JSON.parse(
  readFileSync(join(import.meta.dirname || '.', 'fixtures/comprehensive-test-module.json'), 'utf8')
);

function withDb() {
  const dir = mkdtempSync(join(tmpdir(), 'dm-online-comprehensive-'));
  const database = createDatabase(join(dir, 'test.db'));
  return {
    database,
    cleanup() {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createTestRoom(database) {
  const module = database.createModule({
    ownerPlayerId: 'p1',
    title: '综合测试模组',
    originalName: 'module.json',
    fileType: 'json',
    contentType: 'application/json',
    sizeBytes: 100,
    storagePath: '/tmp/module.json',
    parsedText: JSON.stringify(MODULE_JSON),
    parseStatus: 'PARSED',
    segments: [{ title: '大厅', scene: 'lobby', content: '陈友站在柜台后面。' }]
  });
  const { room } = database.createRoom({
    name: '综合测试房',
    playerId: 'p1',
    displayName: 'Player 1',
    moduleId: module.id
  });
  database.updateCharacterSheet({
    code: room.code,
    playerId: 'p1',
    displayName: 'Player 1',
    characterSheet: testCharacterSheet()
  });
  const task = database.createAiTask({
    code: room.code,
    playerId: 'p1',
    idempotencyKey: 'test-task'
  }).task;
  return { room, task };
}

// ============================================================
// 测试角色卡
// ============================================================
function testCharacterSheet(overrides = {}) {
  return {
    investigator: {
      name: '林娜',
      occupation: '记者',
      age: '28',
      residence: '省城'
    },
    characteristics: {
      STR: 50, CON: 55, SIZ: 45, DEX: 60, APP: 55,
      INT: 70, POW: 65, EDU: 60, Luck: 55
    },
    status: { hp: 10, mp: 13, san: 65, luck: 55 },
    skills: {
      侦查: 60, 聆听: 50, 图书馆使用: 55, 心理学: 45,
      话术: 40, 说服: 35, 恐吓: 20, 魅惑: 25,
      潜行: 30, 妙手: 15, 乔装: 10,
      格斗: 30, 射击: 20, 闪避: 40,
      急救: 30, 攀爬: 20, 驾驶汽车: 25, 锁匠: 10, 医学: 15
    },
    weapons: [],
    equipment: '笔记本、钢笔、手电筒、照相机',
    beliefs: '真相值得被揭露',
    ...overrides
  };
}

// ============================================================
// 模组解析和分段
// ============================================================

test('模块 JSON 解析为合法结构', () => {
  assert.equal(MODULE_JSON.schema_version, '1.0');
  assert.ok(MODULE_JSON.module_info?.title);
  assert.ok(Array.isArray(MODULE_JSON.scenes) && MODULE_JSON.scenes.length >= 5);
  assert.ok(Array.isArray(MODULE_JSON.npcs) && MODULE_JSON.npcs.length >= 6);
  assert.ok(Array.isArray(MODULE_JSON.clues) && MODULE_JSON.clues.length >= 4);
  assert.ok(Array.isArray(MODULE_JSON.checks) && MODULE_JSON.checks.length >= 4);
  assert.ok(MODULE_JSON.ai_dm_global_rules);
  assert.ok(MODULE_JSON.endings?.length >= 2);
});

test('NPC 定义包含技能值供 AI 检定使用', () => {
  const npcsWithSkills = MODULE_JSON.npcs.filter((n) => n.skills && Object.keys(n.skills).length > 0);
  assert.ok(npcsWithSkills.length >= 4, '至少4个NPC定义了技能值');

  // 顾振兴应该有心理学技能（用于对抗谎言的被动检定）
  const gu = MODULE_JSON.npcs.find((n) => n.name === '顾振兴');
  assert.ok(gu?.skills?.['心理学'], '顾振兴需要心理学技能来对抗调查员的谎言');

  // 马大胆应该有格斗技能
  const ma = MODULE_JSON.npcs.find((n) => n.name === '马大胆');
  assert.ok(ma?.skills?.['格斗'], '马大胆需要格斗技能来对抗调查员的攻击');
});

// ============================================================
// AI 对抗检定检测 — 社交类
// ============================================================

test('AI 检测：谎话触发话术检定，NPC 从 moduleJson 获取技能', () => {
  const roomState = {
    messages: [{
      id: 1, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我谎称自己是陈友的远房亲戚，让他相信我是来帮忙的。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '陈友停下手里的活计，眯起眼睛打量着你。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  const check = enhanced.events.opposed_checks[0];
  assert.equal(check.activeSkill, '话术');
  assert.equal(check.passiveNpcName, '陈友');
  assert.equal(check.contestType, 'social');

  // 陈友的心理学技能应该是35（来自模组 JSON）
  const npcSkill = MODULE_JSON.npcs
    .find((n) => n.name === '陈友')?.skills?.['心理学'];
  assert.equal(npcSkill, 35);
});

test('AI 检测：说服触发说服检定', () => {
  const roomState = {
    messages: [{
      id: 2, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我试着说服林处长，让他告诉我们实情而不是打官腔。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '林处长推了推眼镜，嘴角微微抽动。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '说服');
  assert.equal(enhanced.events.opposed_checks[0].passiveNpcName, '林处长');
  assert.equal(enhanced.events.opposed_checks[0].contestType, 'social');

  // 林处长的心理学应该是70
  const npcSkill = MODULE_JSON.npcs
    .find((n) => n.name === '林处长')?.skills?.['心理学'];
  assert.equal(npcSkill, 70);
});

test('AI 检测：恐吓触发恐吓检定', () => {
  const roomState = {
    messages: [{
      id: 3, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我拍桌恐吓马大胆，让他滚开别再挡路。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '马大胆慢慢站起来，指关节捏得咔咔响。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '恐吓');
  assert.equal(enhanced.events.opposed_checks[0].passiveNpcName, '马大胆');
  assert.equal(enhanced.events.opposed_checks[0].contestType, 'social');
});

test('AI 检测：魅惑触发魅惑检定', () => {
  const roomState = {
    messages: [{
      id: 4, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我对吴秀梅微笑，套近乎地跟她寒暄，打听那天晚上的情况。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '吴秀梅抬头看了你一眼，卷着登记簿纸角的手指停了一下。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '魅惑');
});

// ============================================================
// AI 对抗检定检测 — 潜行类
// ============================================================

test('AI 检测：潜行触发潜行检定', () => {
  const roomState = {
    messages: [{
      id: 5, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '趁着保安低头看报纸，我悄悄溜进走廊尽头的门。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '保安翻了一页报纸，走廊里只剩下纸张的沙沙声。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '潜行');
  assert.equal(enhanced.events.opposed_checks[0].passiveNpcName, '保安');
  assert.equal(enhanced.events.opposed_checks[0].contestType, 'stealth');
});

test('AI 检测：偷窃触发妙手检定', () => {
  const roomState = {
    messages: [{
      id: 6, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我趁保安不注意，悄悄偷走他腰间挂着的钥匙串。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '保安的钥匙串在腰间轻轻碰响。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '妙手');
  assert.equal(enhanced.events.opposed_checks[0].contestType, 'stealth');
});

test('AI 检测：乔装触发乔装检定', () => {
  const roomState = {
    messages: [{
      id: 7, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我易容乔装成白主任的模样，试图混进招待所后门。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '板寸头远远看了一眼，手里的火柴盒翻得更快了。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '乔装');
  assert.equal(enhanced.events.opposed_checks[0].contestType, 'stealth');
});

// ============================================================
// AI 对抗检定检测 — 战斗类
// ============================================================

test('AI 检测：格斗攻击触发格斗检定', () => {
  const roomState = {
    messages: [{
      id: 8, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我挥拳攻击板寸头，试图制服他。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '板寸头扔掉火柴盒，双手握拳摆出架势。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '格斗');
  assert.equal(enhanced.events.opposed_checks[0].contestType, 'combat');
});

test('AI 检测：射击触发射击检定', () => {
  const roomState = {
    messages: [{
      id: 9, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我掏出手枪瞄准马大胆，开枪射击他的腿。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '马大胆瞪大了眼睛，手本能地伸向腰间。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '射击');
  assert.equal(enhanced.events.opposed_checks[0].contestType, 'combat');
});

// ============================================================
// AI 必要检定检测
// ============================================================

test('AI 检测：搜索环境触发侦查必要检定', () => {
  const roomState = {
    messages: [{
      id: 10, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我仔细搜索301房间，翻找旅行包和床板下面。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '301房间的窗帘在微风中轻轻晃动。',
    roomState
  });

  assert.ok(Array.isArray(enhanced.events.required_checks), '应推断出必要检定');
  assert.ok(enhanced.events.required_checks.length >= 1);
  assert.equal(enhanced.events.required_checks[0].skill, '侦查');
});

test('AI 检测：查阅资料触发图书馆使用必要检定', () => {
  const roomState = {
    messages: [{
      id: 11, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '我在派出所档案室翻阅旧报纸和卷宗，查资料关于东乡村的历史记录。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '档案室的荧光灯嗡嗡响，空气中弥漫着旧纸张的味道。',
    roomState
  });

  assert.ok(Array.isArray(enhanced.events.required_checks));
  assert.ok(enhanced.events.required_checks.length >= 1);
  assert.equal(enhanced.events.required_checks[0].skill, '图书馆使用');
});

test('AI 检测：专注倾听触发聆听必要检定', () => {
  const roomState = {
    messages: [{
      id: 12, authorType: 'player', messageType: 'ACTION',
      playerId: 'p1', content: '夜深人静，我俯身贴在大厅地板上，倾听有没有地下传来的脚步或声音。'
    }],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '大厅里安静得只剩下墙上的钟在走。',
    roomState
  });

  assert.ok(Array.isArray(enhanced.events.required_checks));
  assert.ok(enhanced.events.required_checks.length >= 1);
  assert.equal(enhanced.events.required_checks[0].skill, '聆听');
});

// ============================================================
// AI 优先对抗检定 — 冲突行为必须优先于必要检定
// ============================================================

test('AI 检测：对抗行动优先——如果行动是撒谎，模型返回的必要检定必须被丢弃', () => {
  // 模拟 AI 模型错误地把撒谎同时返回了 required_checks 和空的 opposed_checks
  const enhanced = enhanceStructuredEvents({
    events: {
      required_checks: [
        { targetPlayerId: 'p1', skill: '话术', difficulty: 'REGULAR', reason: '模型误判' }
      ]
    },
    narrative: '顾振兴擦了擦汗，眼神游移不定。',
    roomState: {
      messages: [{
        id: 20, authorType: 'player', messageType: 'ACTION',
        playerId: 'p1', content: '我对顾振兴谎称我们是省纪委派来的暗访组，让他老实交代。'
      }],
      moduleJson: MODULE_JSON
    }
  });

  // required_checks 应该被丢弃
  assert.equal(enhanced.events.required_checks, undefined);
  // opposed_checks 应该被推断出来
  assert.equal(enhanced.events.opposed_checks.length, 1);
  assert.equal(enhanced.events.opposed_checks[0].activeSkill, '话术');
  assert.equal(enhanced.events.opposed_checks[0].passiveNpcName, '顾振兴');
  assert.equal(enhanced.diagnostics.droppedRequiredChecksForOpposedAction, 1);
});

// ============================================================
// NPC 名称推断
// ============================================================

test('AI 检测：从最近对话中推断 NPC 名称', () => {
  // 当行动文本中只有代词"他"，后端应该从 narrative 和最近聊天中推断 NPC
  // 注意：行动文本中不能出现显式的 NPC 名称（如"顾所长"），否则显式匹配优先
  const roomState = {
    messages: [
      {
        id: 21, authorType: 'dm', messageType: 'AI_DM',
        playerId: '', content: '陈友叹了口气，把围裙摘下来。他的眼神闪烁不定，似乎在做艰难的决定。'
      },
      {
        id: 22, authorType: 'player', messageType: 'ACTION',
        playerId: 'p1', content: '我趁他犹豫的时候骗他说上级已经在调查了，让他放心说实话。'
      }
    ],
    moduleJson: MODULE_JSON
  };

  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '陈友的手停在半空中。',
    roomState
  });

  assert.equal(enhanced.events.opposed_checks.length, 1);
  // 行动中没有显式 NPC 名——通过 narrative 中的"陈友"和 DM 消息上下文推断
  assert.equal(enhanced.events.opposed_checks[0].passiveNpcName, '陈友');
});

// ============================================================
// 结构化事件后处理
// ============================================================

test('叙事清理：删除 AI 回复末尾的行动建议', () => {
  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: [
      '顾振兴擦了擦额头的汗。',
      '',
      '你可以：',
      '- 继续追问账目的事',
      '- 去灶房找陈师傅聊聊',
      '- 返回301房间再检查一次'
    ].join('\n'),
    roomState: {
      messages: [{
        id: 30, authorType: 'player', messageType: 'ACTION', playerId: 'p1',
        content: '我盯着顾振兴的眼睛，等他解释。'
      }],
      moduleJson: MODULE_JSON
    }
  });

  assert.ok(enhanced.diagnostics.strippedActionSuggestions);
  assert.ok(!enhanced.narrative.includes('你可以'));
  assert.ok(!enhanced.narrative.includes('继续追问'));
});

test('叙事清理：对抗检定前截断决定性结果描述', () => {
  const enhanced = enhanceStructuredEvents({
    events: {},
    narrative: '陈友似乎相信了你的说辞，放松了警惕，转身去拿账本。但他突然又回头看了你一眼。',
    roomState: {
      messages: [{
        id: 31, authorType: 'player', messageType: 'ACTION', playerId: 'p1',
        content: '我骗陈友说自己是顾所长派来的人。'
      }],
      moduleJson: MODULE_JSON
    }
  });

  // 应该截掉"相信了你的说辞"及之后的内容
  assert.ok(enhanced.diagnostics.strippedDecisiveOutcome);
  assert.ok(!enhanced.narrative.includes('相信了'));
});

// ============================================================
// 结构化事件验证（模组上下文）
// ============================================================

test('结构化事件：完整场景变更 event', () => {
  const { valid, rejected } = validateStructuredEvents({
    scene_change: {
      newScene: '招待所灶房',
      newLocation: '后院煤棚',
      timeElapsed: '15 分钟',
      description: '煤棚里弥漫着煤灰的味道，手电筒的光照出了角落里一扇低矮的铁门。'
    },
    summary_update: '调查员在煤棚里发现了通往地下室的暗门。'
  });

  assert.equal(rejected.length, 0);
  assert.equal(valid.scene_change.newScene, '招待所灶房');
  assert.equal(valid.summary_update, '调查员在煤棚里发现了通往地下室的暗门。');
});

test('结构化事件：多个必要检定同时处理', () => {
  const events = {
    required_checks: [
      { skill: '侦查', difficulty: 'REGULAR', reason: '检查书桌', playerHint: '书桌边缘有可疑划痕' },
      { skill: '侦查', difficulty: 'HARD', reason: '检查窗台', playerHint: '窗台积灰中有烟头' },
      { skill: '聆听', difficulty: 'REGULAR', reason: '听地下动静', playerHint: '屏住呼吸细听' }
    ]
  };

  const { valid, rejected } = validateStructuredEvents(events);
  assert.equal(rejected.length, 0);
  assert.equal(valid.required_checks.length, 3);
});

test('结构化事件：状态变更只允许合法字段', () => {
  const events = {
    proposed_state_changes: [
      { targetPlayerId: 'p1', fieldPath: 'status.san', newValue: 50, reason: '目睹恐怖场景' },
      { targetPlayerId: 'p1', fieldPath: 'status.hp', newValue: 8, reason: '受伤' },
      { targetPlayerId: 'p1', fieldPath: 'characteristics.Luck', newValue: 45, reason: '消耗幸运' }
    ]
  };

  const { valid, rejected } = validateStructuredEvents(events);
  assert.equal(rejected.length, 0);
  assert.equal(valid.proposed_state_changes.length, 3);
});

test('结构化事件：拒绝非法状态变更字段', () => {
  const events = {
    proposed_state_changes: [
      { targetPlayerId: 'p1', fieldPath: 'skills.侦查', newValue: 80, reason: '作弊' },
      { targetPlayerId: 'p1', fieldPath: 'inventory.gun', newValue: 1, reason: '获得武器' }
    ]
  };

  const { valid, rejected, issues } = validateStructuredEvents(events);
  assert.ok(rejected.includes('proposed_state_changes'));
  assert.ok(issues.some((i) => i.includes('Invalid state change field')));
});

test('结构化事件：NPC 状态变更包括离场标记', () => {
  const events = {
    npc_state_changes: [
      { npcName: '顾振兴', disposition: '恐惧', location: '地下室', isPresent: true },
      { npcName: '板寸头', disposition: '', location: '', isPresent: false }
    ]
  };

  const { valid, rejected } = validateStructuredEvents(events);
  assert.equal(rejected.length, 0);
  assert.equal(valid.npc_state_changes.length, 2);
  assert.equal(valid.npc_state_changes[1].isPresent, false);
});

test('事件应用：scene_change 不覆盖 summary_update，并写入 sceneState', () => {
  const { database, cleanup } = withDb();
  try {
    const { room, task } = createTestRoom(database);
    const hubEvents = [];
    const hub = {
      broadcast: (code, event, payload) => hubEvents.push({ code, event, payload }),
      sendTo: (code, playerId, event, payload) => hubEvents.push({ code, playerId, event, payload })
    };
    const { applyStructuredEvents } = createEventApplier({ database, hub, addAiLog: () => undefined });

    database.forceUpdateSummary(room.id, '旧摘要');
    applyStructuredEvents(room.code, task.uid, {
      summary_update: '新摘要',
      scene_change: {
        newScene: '招待所灶房',
        newLocation: '后院煤棚',
        timeElapsed: '15分钟',
        description: '调查员进入煤棚。'
      }
    }, null, MODULE_JSON);

    const state = database.getRoomState(room.code);
    assert.equal(state.room.summary, '新摘要');
    const sceneState = JSON.parse(state.room.sceneState);
    assert.equal(sceneState.currentScene, '招待所灶房');
    assert.equal(sceneState.currentLocation, '后院煤棚');
    assert.ok(hubEvents.some((entry) => entry.event === 'message_created' && entry.payload.message.displayName === '场景'));
  } finally {
    cleanup();
  }
});

test('事件应用：线索和 NPC 状态写入结构化玩家/房间状态', () => {
  const { database, cleanup } = withDb();
  try {
    const { room, task } = createTestRoom(database);
    database.joinRoom({ code: room.code, playerId: 'p2', displayName: 'Player 2' });
    const logs = [];
    const hubEvents = [];
    const hub = {
      broadcast: (code, event, payload) => hubEvents.push({ code, event, payload }),
      sendTo: (code, playerId, event, payload) => hubEvents.push({ code, playerId, event, payload })
    };
    const { applyStructuredEvents } = createEventApplier({
      database,
      hub,
      addAiLog: (_code, entry) => logs.push(entry)
    });

    applyStructuredEvents(room.code, task.uid, {
      clues_revealed: [
        {
          clueId: 'register_alteration',
          source: '侦查成功',
          content: '登记簿上王建国的房间号被涂改过。'
        },
        {
          clueId: 'private_whisper',
          source: '心理学成功',
          content: '顾振兴说到三楼时明显停顿。',
          privateTo: 'p1'
        }
      ],
      npc_state_changes: [
        {
          npcId: 'guzhenxing',
          npcName: '顾振兴',
          disposition: '紧张',
          location: '招待所大厅',
          isPresent: true,
          notes: '频繁擦汗'
        }
      ]
    }, null, MODULE_JSON);

    const p1 = database.getParticipant(room.code, 'p1').participant;
    const p2 = database.getParticipant(room.code, 'p2').participant;
    assert.ok(p1.discoveredClues.some((clue) => clue.id === 'register_alteration'));
    assert.ok(p1.discoveredClues.some((clue) => clue.id === 'private_whisper'));
    assert.ok(p2.discoveredClues.some((clue) => clue.id === 'register_alteration'));
    assert.equal(p2.discoveredClues.some((clue) => clue.id === 'private_whisper'), false);
    assert.ok(p1.knownNpcs.some((npc) => npc.id === 'guzhenxing' && npc.disposition === '紧张'));
    assert.ok(p2.knownNpcs.some((npc) => npc.id === 'guzhenxing' && npc.location === '招待所大厅'));

    const sceneState = JSON.parse(database.getRoomByCode(room.code).sceneState);
    assert.equal(sceneState.npcStates.guzhenxing.name, '顾振兴');
    assert.equal(sceneState.npcStates.guzhenxing.disposition, '紧张');
    assert.ok(logs.some((entry) => entry.stage === 'clue-state-updated' && entry.clueId === 'register_alteration'));
    assert.ok(logs.some((entry) => entry.stage === 'npc-state-updated' && entry.npcId === 'guzhenxing'));
    assert.ok(hubEvents.some((entry) => entry.event === 'message_created' && entry.payload.message.displayName === '线索'));
  } finally {
    cleanup();
  }
});

test('事件应用：NPC 技能非法时回退角色默认值并继续对抗检定', () => {
  const { database, cleanup } = withDb();
  try {
    const { room, task } = createTestRoom(database);
    const logs = [];
    const hub = {
      broadcast: () => undefined,
      sendTo: () => undefined
    };
    const { applyStructuredEvents } = createEventApplier({
      database,
      hub,
      addAiLog: (_code, entry) => logs.push(entry)
    });

    applyStructuredEvents(room.code, task.uid, {
      opposed_checks: [{
        activePlayerId: 'p1',
        activeSkill: '话术',
        passiveNpcName: '保安',
        passiveSkill: '心理学',
        contestType: 'social',
        reason: '玩家对保安撒谎'
      }]
    }, null, {
      npcs: [{
        name: '保安',
        role: '保安',
        skills: { 心理学: '不详' }
      }]
    });

    const checkMessage = database.getRoomState(room.code).messages
      .find((message) => message.displayName === '对抗检定');
    assert.ok(checkMessage);
    assert.match(checkMessage.content, /心理学\(65\)/);
    assert.ok(logs.some((entry) => entry.stage === 'npc-skill-fallback' && entry.fallback === 65));
  } finally {
    cleanup();
  }
});

// ============================================================
// 角色定位（getCheckTarget 使用模组上下文中的技能名）
// ============================================================

test('getCheckTarget：识别中文技能名', () => {
  const sheet = testCharacterSheet();
  const result = getCheckTarget(sheet, '侦查');
  assert.equal(result.type, 'skill');
  assert.equal(result.label, '侦查');
  assert.equal(result.target, 60);
});

test('getCheckTarget：识别属性别名（DEX 中文名）', () => {
  const sheet = testCharacterSheet();
  const result = getCheckTarget(sheet, '敏捷');
  assert.equal(result.type, 'characteristic');
  assert.equal(result.label, 'DEX');
  assert.equal(result.target, 60);
});

test('getCheckTarget：识别属性英文名', () => {
  const sheet = testCharacterSheet();
  const result = getCheckTarget(sheet, 'POW');
  assert.equal(result.type, 'characteristic');
  assert.equal(result.label, 'POW');
  assert.equal(result.target, 65);
});

// ============================================================
// extractStructuredEvents 边界情况
// ============================================================

test('extractStructuredEvents：多个 JSON 块只取最后一个', () => {
  const text = [
    '第一段叙事。',
    '```json', JSON.stringify({ required_checks: [{ skill: '侦查', difficulty: 'REGULAR' }] }), '```',
    '中间叙事。',
    '```json', JSON.stringify({ summary_update: '最终摘要' }), '```'
  ].join('\n');

  const { narrative, events } = extractStructuredEvents(text);
  assert.match(narrative, /第一段叙事/);
  assert.match(narrative, /中间叙事/);
  // 两个 JSON 块的事件应该合并
  assert.equal(events.required_checks?.[0]?.skill, '侦查');
  assert.equal(events.summary_update, '最终摘要');
});
