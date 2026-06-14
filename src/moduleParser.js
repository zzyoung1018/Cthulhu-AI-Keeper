import { HttpError } from './errors.js';

const MAX_MODULE_SIZE = 12 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['json']);
const ALLOWED_MIME_TYPES = new Set([
  'application/json',
  'application/octet-stream'
]);

function extensionFromName(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || ''));
  return match ? match[1].toLowerCase() : '';
}

function sanitizeFileName(fileName) {
  return String(fileName || 'module')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'module';
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[  ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function validateModuleFile({ fileName, contentType, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HttpError(400, 'Module file is required');
  }
  if (buffer.length > MAX_MODULE_SIZE) {
    throw new HttpError(413, 'Module file is too large');
  }

  const extension = extensionFromName(fileName);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new HttpError(415, 'Only JSON modules are supported');
  }
  if (contentType && !ALLOWED_MIME_TYPES.has(contentType) && contentType !== 'application/octet-stream') {
    // Allow octet-stream as browsers sometimes send it
    if (!contentType.startsWith('application/')) {
      throw new HttpError(415, 'Unsupported module content type');
    }
  }

  return {
    originalName: sanitizeFileName(fileName),
    extension,
    contentType: contentType || 'application/octet-stream',
    size: buffer.length
  };
}

function parseJsonModule(buffer) {
  const text = buffer.toString('utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new HttpError(422, `Invalid JSON module: ${error.message}`);
  }
  if (!data || typeof data !== 'object') {
    throw new HttpError(422, 'JSON module must be an object');
  }
  if (!data.schema_version) {
    throw new HttpError(422, 'JSON module missing schema_version');
  }
  return data;
}

export function extractModuleText({ extension, buffer }) {
  if (extension === 'json') {
    const data = parseJsonModule(buffer);
    return JSON.stringify(data, null, 2);
  }
  throw new HttpError(415, 'Only JSON modules are supported');
}

export function segmentModuleText(text, extension = 'json') {
  return segmentJsonModule(text);
}

function segmentJsonModule(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const segments = [];

  // 1. Module info
  if (data.module_info) {
    const mi = data.module_info;
    segments.push({
      title: mi.title || '模组信息',
      scene: '模组概览',
      content: [
        `标题：${mi.title || ''}`,
        `系统：${mi.system || 'CoC 7e'}`,
        `时代：${mi.time_period || ''}`,
        `地点：${mi.location || ''}`,
        `设定：${mi.setting || ''}`,
        `主题：${(mi.themes || []).join('、')}`,
        `氛围：${mi.tone || ''}`,
        `建议人数：${mi.recommended_players || ''}`,
        `预计时长：${mi.estimated_duration || ''}`
      ].filter(Boolean).join('\n')
    });
  }

  // 2. Keeper overview
  if (data.keeper_overview) {
    const ko = data.keeper_overview;
    const content = [
      ko.truth ? `真相：${ko.truth}` : '',
      ko.main_conflict ? `主要冲突：${ko.main_conflict}` : '',
      ko.main_mystery ? `核心谜团：${ko.main_mystery}` : '',
      ko.villain_or_threat ? `反派/威胁：${ko.villain_or_threat}` : '',
      ko.investigation_goal ? `调查目标：${ko.investigation_goal}` : '',
      ko.default_opening ? `默认开场：${ko.default_opening}` : ''
    ].filter(Boolean).join('\n');
    if (content) segments.push({ title: '守秘人概览', scene: '守秘人信息', content });
  }

  // 3. Player opening
  if (data.player_opening) {
    const po = data.player_opening;
    const content = [
      po.initial_public_information || '',
      po.initial_objective ? `初始目标：${po.initial_objective}` : '',
      po.suggested_intro_text || ''
    ].filter(Boolean).join('\n');
    if (content) segments.push({ title: '开场信息', scene: '玩家开场', content });
  }

  // 4. Each scene
  if (Array.isArray(data.scenes)) {
    for (const scene of data.scenes) {
      const content = [
        scene.player_visible_description || '',
        scene.keeper_secret ? `[守秘人] ${scene.keeper_secret}` : '',
        scene.when_players_enter ? `进入时：${scene.when_players_enter}` : '',
        scene.when_players_search ? `搜索时：${scene.when_players_search}` : '',
        scene.default_ai_dm_instruction ? `AI指引：${scene.default_ai_dm_instruction}` : '',
        scene.entry_conditions?.length ? `进入条件：${scene.entry_conditions.join('；')}` : '',
        scene.exit_conditions?.length ? `离开条件：${scene.exit_conditions.join('；')}` : ''
      ].filter(Boolean).join('\n');
      if (content) {
        segments.push({
          title: scene.name || scene.scene_id,
          scene: scene.scene_id || scene.name || '未命名场景',
          content
        });
      }
    }
  }

  // 5. Each NPC
  if (Array.isArray(data.npcs)) {
    for (const npc of data.npcs) {
      const content = [
        npc.role ? `身份：${npc.role}` : '',
        npc.first_impression ? `第一印象：${npc.first_impression}` : '',
        npc.player_visible_info || '',
        npc.personality ? `性格：${npc.personality}` : '',
        npc.dialogue_style ? `对话风格：${npc.dialogue_style}` : '',
        npc.ai_dm_instruction ? `AI指引：${npc.ai_dm_instruction}` : ''
      ].filter(Boolean).join('\n');
      if (content) {
        segments.push({
          title: `NPC: ${npc.name || npc.npc_id}`,
          scene: npc.current_location_scene_id || npc.npc_id || 'npc',
          content
        });
      }
    }
  }

  // 6. Each clue
  if (Array.isArray(data.clues)) {
    for (const clue of data.clues) {
      const content = [
        `核心线索：${clue.is_core_clue ? '是' : '否'} | 已发现：${clue.discovered ? '是' : '否'}`,
        clue.reveal_condition ? `发现条件：${clue.reveal_condition}` : '',
        clue.player_visible_text || '',
        clue.ai_dm_instruction ? `AI指引：${clue.ai_dm_instruction}` : ''
      ].filter(Boolean).join('\n');
      if (content) {
        segments.push({
          title: `线索: ${clue.name || clue.clue_id}`,
          scene: clue.scene_id || clue.clue_id || 'clue',
          content
        });
      }
    }
  }

  // 7. Checks
  if (Array.isArray(data.checks)) {
    for (const check of data.checks) {
      const content = [
        `技能：${check.skill} | 难度：${check.difficulty}`,
        check.trigger ? `触发：${check.trigger}` : '',
        check.success ? `成功：${check.success}` : '',
        check.failure ? `失败：${check.failure}` : '',
        check.can_push ? '可推骰' : '',
        check.ai_dm_instruction ? `AI指引：${check.ai_dm_instruction}` : ''
      ].filter(Boolean).join('\n');
      if (content) {
        segments.push({
          title: `检定: ${check.check_id}`,
          scene: check.scene_id || 'check',
          content
        });
      }
    }
  }

  // 8. Maps
  if (Array.isArray(data.maps)) {
    for (const map of data.maps) {
      const areaDescs = (map.areas || []).map((a) =>
        `${a.name || a.area_id}: ${a.player_visible_description || ''}`
      ).join('\n');
      const content = [
        map.player_visible_description || '',
        map.ai_dm_instruction || '',
        areaDescs
      ].filter(Boolean).join('\n');
      if (content) {
        segments.push({
          title: `地图: ${map.name || map.map_id}`,
          scene: (map.related_scene_ids || [])[0] || 'map',
          content
        });
      }
    }
  }

  // 9. Visual assets
  if (Array.isArray(data.visual_assets)) {
    for (const asset of data.visual_assets) {
      const content = [
        `类型：${asset.asset_type || ''}`,
        asset.player_visible_description || '',
        asset.ocr_text ? `OCR文字：${asset.ocr_text}` : '',
        asset.ai_dm_instruction || ''
      ].filter(Boolean).join('\n');
      if (content) {
        segments.push({
          title: `素材: ${asset.name || asset.asset_id}`,
          scene: (asset.related_scene_ids || [])[0] || 'asset',
          content
        });
      }
    }
  }

  // 10. Sanity and danger events
  if (Array.isArray(data.sanity_events)) {
    for (const ev of data.sanity_events) {
      segments.push({
        title: `理智事件: ${ev.san_event_id}`,
        scene: ev.scene_id || 'sanity',
        content: [ev.trigger, ev.description, ev.ai_dm_instruction || ''].filter(Boolean).join('\n')
      });
    }
  }
  if (Array.isArray(data.danger_events)) {
    for (const ev of data.danger_events) {
      segments.push({
        title: `危险事件: ${ev.event_id}`,
        scene: ev.scene_id || 'danger',
        content: [ev.trigger, ev.player_visible_description || '', ev.ai_dm_instruction || ''].filter(Boolean).join('\n')
      });
    }
  }

  // 11. Story progression
  if (data.story_progression) {
    const sp = data.story_progression;
    const content = [
      sp.ai_dm_pacing_notes || '',
      sp.recommended_scene_order?.length ? `推荐顺序：${sp.recommended_scene_order.join(' → ')}` : '',
      sp.bottleneck_risks?.length ? `瓶颈风险：${sp.bottleneck_risks.join('；')}` : ''
    ].filter(Boolean).join('\n');
    if (content) segments.push({ title: '剧情推进指南', scene: 'story', content });
  }

  // 12. AI DM global rules
  if (data.ai_dm_global_rules) {
    const rules = data.ai_dm_global_rules;
    const content = [
      rules.role || '',
      ...(rules.must_follow || []).map((r, i) => `${i + 1}. ${r}`),
      rules.style ? `叙述长度：${rules.style.narration_length || ''}` : '',
      rules.style ? `语气：${rules.style.tone || ''}` : '',
      rules.style?.avoid?.length ? `避免：${rules.style.avoid.join('、')}` : ''
    ].filter(Boolean).join('\n');
    if (content) segments.push({ title: 'AI DM 全局规则', scene: 'rules', content });
  }

  // 13. Endings
  if (Array.isArray(data.endings)) {
    for (const ending of data.endings) {
      segments.push({
        title: `结局: ${ending.name || ending.ending_id}`,
        scene: 'ending',
        content: [ending.condition || '', ending.ai_dm_instruction || ''].filter(Boolean).join('\n')
      });
    }
  }

  return segments.slice(0, 400);
}

export function scoreModuleSegment(segment, query) {
  const normalizedQuery = String(query || '').toLowerCase();
  const terms = normalizedQuery
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2)
    .slice(0, 30);
  const cjkTerms = [...normalizedQuery.matchAll(/[\p{Script=Han}]{2,}/gu)]
    .flatMap((match) => {
      const value = match[0];
      const grams = [];
      for (let index = 0; index < value.length - 1; index += 1) {
        grams.push(value.slice(index, index + 2));
      }
      return grams;
    })
    .slice(0, 40);
  const allTerms = [...new Set([...terms, ...cjkTerms])];
  if (allTerms.length === 0) return 0;

  const haystack = `${segment.title}\n${segment.scene}\n${segment.content}`.toLowerCase();
  return allTerms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export { MAX_MODULE_SIZE };
