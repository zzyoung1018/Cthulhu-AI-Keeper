// AI structured output parser and validator.
// AI replies split into narrative text (streamed to players) and structured events
// parsed after completion. Events are validated before being written to the database.

const EVENT_SCHEMAS = {
  required_checks: {
    type: 'array',
    maxItems: 12,
    itemSchema: {
      type: 'object',
      required: ['skill', 'difficulty'],
      properties: {
        skill: 'string',
        difficulty: 'string',
        reason: 'string',
        playerHint: 'string',
        targetPlayerId: 'string'
      }
    }
  },
  opposed_checks: {
    type: 'array',
    maxItems: 8,
    itemSchema: {
      type: 'object',
      required: ['activePlayerId', 'activeSkill', 'passiveNpcName', 'passiveSkill', 'reason'],
      properties: {
        activePlayerId: 'string',
        activeSkill: 'string',
        passiveNpcName: 'string',
        passiveSkill: 'string',
        contestType: 'string',
        reason: 'string',
        playerHint: 'string',
        successResult: 'string',
        failureResult: 'string'
      }
    }
  },
  proposed_state_changes: {
    type: 'array',
    maxItems: 30,
    itemSchema: {
      type: 'object',
      required: ['targetPlayerId', 'fieldPath', 'newValue'],
      properties: {
        targetPlayerId: 'string',
        fieldPath: 'string',
        newValue: 'any',
        reason: 'string'
      }
    }
  },
  clues_revealed: {
    type: 'array',
    maxItems: 20,
    itemSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: 'string',
        privateTo: 'string',
        source: 'string'
      }
    }
  },
  scene_change: {
    type: 'object',
    properties: {
      newScene: 'string',
      newLocation: 'string',
      timeElapsed: 'string',
      description: 'string'
    }
  },
  npc_state_changes: {
    type: 'array',
    maxItems: 20,
    itemSchema: {
      type: 'object',
      required: ['npcName'],
      properties: {
        npcName: 'string',
        disposition: 'string',
        location: 'string',
        notes: 'string',
        isPresent: 'boolean'
      }
    }
  },
  summary_update: 'string'
};

const VALID_FIELD_PATHS = new Set([
  'status.hp',
  'status.mp',
  'status.san',
  'status.luck',
  'characteristics.STR',
  'characteristics.CON',
  'characteristics.SIZ',
  'characteristics.DEX',
  'characteristics.APP',
  'characteristics.INT',
  'characteristics.POW',
  'characteristics.EDU',
  'characteristics.Luck'
]);

function validateBySchema(value, schema, path = '') {
  const issues = [];

  if (schema === 'string') {
    if (typeof value !== 'string') issues.push(`${path}: expected string`);
    return issues;
  }

  if (schema === 'any') return issues;

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`${path}: expected object`);
      return issues;
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) {
        issues.push(...validateBySchema(value[key], propSchema, path ? `${path}.${key}` : key));
      }
    }
    return issues;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push(`${path}: expected array`);
      return issues;
    }
    if (value.length > schema.maxItems) {
      issues.push(`${path}: too many items (max ${schema.maxItems})`);
    }
    const itemSchema = schema.itemSchema;
    if (itemSchema) {
      for (let index = 0; index < Math.min(value.length, schema.maxItems); index += 1) {
        issues.push(...validateBySchema(value[index], itemSchema, `${path}[${index}]`));
      }
    }
    return issues;
  }

  if (schema === 'string') {
    if (typeof value !== 'string') issues.push(`${path}: expected string`);
  }

  return issues;
}

function validateStateChangeField(fieldPath) {
  if (!VALID_FIELD_PATHS.has(fieldPath)) {
    return [`Invalid state change field: ${fieldPath}`];
  }

  if (fieldPath.startsWith('status.')) {
    const [, resource] = fieldPath.split('.');
    const limits = {
      hp: { min: 0 },
      mp: { min: 0 },
      san: { min: 0, max: 99 },
      luck: { min: 0, max: 100 }
    };
    if (limits[resource]) {
      return []; // bounds checked when applying
    }
  }

  if (fieldPath.startsWith('characteristics.')) {
    return []; // All characteristics are 0-100, checked when applying
  }

  return [];
}

function parseStructuredBlock(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const fenceStart = /^```(?:json)?\s*$/m;
  const startMatch = trimmed.match(fenceStart);
  if (!startMatch) return null;

  const afterStart = trimmed.slice((startMatch.index || 0) + startMatch[0].length);
  const endMatch = afterStart.match(/^```\s*$/m);
  if (!endMatch) return null;

  const jsonText = afterStart.slice(0, endMatch.index).trim();
  if (!jsonText) return null;

  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

export function extractStructuredEvents(text) {
  const narrative = [];
  const events = {};
  let remaining = text;

  while (remaining.length > 0) {
    const fenceStart = /^```(?:json)?\s*$/m;
    const startMatch = remaining.match(fenceStart);

    if (!startMatch) {
      narrative.push(remaining.trimEnd());
      break;
    }

    narrative.push(remaining.slice(0, startMatch.index).trimEnd());

    const afterStart = remaining.slice((startMatch.index || 0) + startMatch[0].length);
    const endMatch = afterStart.match(/^```\s*$/m);

    if (!endMatch) {
      narrative.push(remaining.slice(startMatch.index).trimEnd());
      break;
    }

    const jsonText = afterStart.slice(0, endMatch.index).trim();
    remaining = afterStart.slice((endMatch.index || 0) + endMatch[0].length);

    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(events, parsed);
      }
    } catch {
      // Invalid JSON block — leave it in narrative
      narrative.push(remaining.slice(startMatch.index, startMatch.index + endMatch.index + endMatch[0].length + afterStart.length));
    }
  }

  return {
    narrative: narrative.filter(Boolean).join('\n\n').trim(),
    events
  };
}

export function validateStructuredEvents(events) {
  const valid = {};
  const rejected = [];
  const issues = [];

  for (const [key, schema] of Object.entries(EVENT_SCHEMAS)) {
    const value = events[key];
    if (value === undefined || value === null) continue;

    if (key === 'summary_update') {
      if (typeof value === 'string' && value.trim().length <= 6000) {
        valid[key] = value.trim();
      } else {
        rejected.push(key);
        issues.push(`${key}: must be a string (max 6000 chars)`);
      }
      continue;
    }

    const schemaIssues = validateBySchema(value, schema, key);
    if (schemaIssues.length > 0) {
      rejected.push(key);
      issues.push(...schemaIssues);
      continue;
    }

    if (key === 'proposed_state_changes') {
      const fieldIssues = value.flatMap((change) => validateStateChangeField(change.fieldPath));
      if (fieldIssues.length > 0) {
        rejected.push(key);
        issues.push(...fieldIssues);
        continue;
      }
    }

    valid[key] = value;
  }

  return { valid, rejected, issues };
}

