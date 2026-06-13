import { inflateRawSync } from 'node:zlib';
import { HttpError } from './errors.js';

const MAX_MODULE_SIZE = 12 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['txt', 'pdf', 'docx', 'json']);
const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
    .replace(/[ \u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function xmlDecode(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function decodePdfString(value) {
  return value
    .replace(/\\([nrtbf()\\])/g, (_, char) => {
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      return map[char] || char;
    })
    .replace(/\\([0-7]{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function extractPdfText(buffer) {
  const source = buffer.toString('latin1');
  const pieces = [];
  const textString = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  const textArray = /\[((?:.|\n)*?)\]\s*TJ/g;

  for (const match of source.matchAll(textString)) {
    pieces.push(decodePdfString(match[0].replace(/\s*Tj$/, '').slice(1, -1)));
  }

  for (const match of source.matchAll(textArray)) {
    for (const item of match[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      pieces.push(decodePdfString(item[0].slice(1, -1)));
    }
  }

  return normalizeText(pieces.join('\n'));
}

function findZipEntry(buffer, wantedName) {
  let offset = 0;
  while (offset + 30 < buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataEnd = dataStart + compressedSize;

    if (name === wantedName) {
      const data = buffer.subarray(dataStart, dataEnd);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { finishFlush: 2 });
      throw new HttpError(415, 'Unsupported DOCX compression method');
    }

    offset = Math.max(dataEnd, offset + 30);
    if (uncompressedSize > 50 * 1024 * 1024) throw new HttpError(413, 'DOCX entry too large');
  }

  return null;
}

function extractDocxText(buffer) {
  const documentXml = findZipEntry(buffer, 'word/document.xml');
  if (!documentXml) throw new HttpError(422, 'DOCX text could not be extracted');
  const xml = documentXml.toString('utf8');
  const withBreaks = xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n');
  const pieces = [];
  for (const match of withBreaks.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs)) {
    pieces.push(xmlDecode(match[1]));
  }
  return normalizeText(pieces.join(' '));
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
    throw new HttpError(415, 'Only TXT, PDF, and DOCX modules are supported');
  }
  if (contentType && !ALLOWED_MIME_TYPES.has(contentType)) {
    throw new HttpError(415, 'Unsupported module content type');
  }

  if (extension === 'pdf' && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new HttpError(415, 'Invalid PDF file');
  }
  if (extension === 'docx' && buffer.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new HttpError(415, 'Invalid DOCX file');
  }

  return {
    originalName: sanitizeFileName(fileName),
    extension,
    contentType: contentType || 'application/octet-stream',
    size: buffer.length
  };
}

export function extractModuleText({ extension, buffer }) {
  if (extension === 'txt') return normalizeText(buffer.toString('utf8'));
  if (extension === 'docx') return extractDocxText(buffer);
  if (extension === 'pdf') return extractPdfText(buffer);
  if (extension === 'json') return extractJsonModuleText(buffer);
  throw new HttpError(415, 'Unsupported module file type');
}

export function segmentModuleText(text, extension = 'txt') {
  if (extension === 'json') return segmentJsonModule(text);
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const headingPattern = /^(#{1,6}\s+.+|第[一二三四五六七八九十百零0-9]+[章节幕场].*|场景\s*[:：].+|Scene\s+\d+.*|Chapter\s+\d+.*)$/gim;
  const headings = [...normalized.matchAll(headingPattern)];
  const sections = [];

  if (headings.length === 0) {
    sections.push({ title: '正文', content: normalized });
  } else {
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      const next = headings[index + 1];
      const title = heading[0].replace(/^#{1,6}\s+/, '').trim();
      const contentStart = heading.index + heading[0].length;
      const contentEnd = next ? next.index : normalized.length;
      sections.push({
        title,
        content: normalizeText(normalized.slice(contentStart, contentEnd))
      });
    }
  }

  const segments = [];
  for (const section of sections) {
    const paragraphs = section.content.split(/\n{2,}/).filter(Boolean);
    let chunk = '';
    let chunkIndex = 1;
    const flush = () => {
      const content = normalizeText(chunk);
      if (content) {
        segments.push({
          title: section.title,
          scene: `${section.title} #${chunkIndex}`,
          content
        });
        chunkIndex += 1;
      }
      chunk = '';
    };

    for (const paragraph of paragraphs) {
      if ((chunk + '\n\n' + paragraph).length > 1800) flush();
      chunk = chunk ? `${chunk}\n\n${paragraph}` : paragraph;
    }
    flush();
  }

  return segments.slice(0, 400);
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

function extractJsonModuleText(buffer) {
  const data = parseJsonModule(buffer);
  // Return pretty-printed JSON as the "parsed text" for keeper preview
  return JSON.stringify(data, null, 2);
}

function segmentJsonModule(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const segments = [];

  // 1. Module info segment
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
    if (content) {
      segments.push({ title: '守秘人概览', scene: '守秘人信息', content });
    }
  }

  // 3. Player opening
  if (data.player_opening) {
    const po = data.player_opening;
    const content = [
      po.initial_public_information || '',
      po.initial_objective ? `初始目标：${po.initial_objective}` : '',
      po.suggested_intro_text || ''
    ].filter(Boolean).join('\n');
    if (content) {
      segments.push({ title: '开场信息', scene: '玩家开场', content });
    }
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
      const areaDescriptions = (map.areas || []).map((a) =>
        `${a.name || a.area_id}: ${a.player_visible_description || ''}`
      ).join('\n');
      const content = [
        map.player_visible_description || '',
        map.ai_dm_instruction || '',
        areaDescriptions
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

  // 9. Visual assets (handouts, illustrations, photos)
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
    if (content) {
      segments.push({ title: '剧情推进指南', scene: 'story', content });
    }
  }

  // 12. AI DM global rules (always include as a segment)
  if (data.ai_dm_global_rules) {
    const rules = data.ai_dm_global_rules;
    const content = [
      rules.role || '',
      ...(rules.must_follow || []).map((r, i) => `${i + 1}. ${r}`),
      rules.style ? `叙述长度：${rules.style.narration_length || ''}` : '',
      rules.style ? `语气：${rules.style.tone || ''}` : '',
      rules.style?.avoid?.length ? `避免：${rules.style.avoid.join('、')}` : ''
    ].filter(Boolean).join('\n');
    if (content) {
      segments.push({ title: 'AI DM 全局规则', scene: 'rules', content });
    }
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

  // Cap at 400 segments
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
