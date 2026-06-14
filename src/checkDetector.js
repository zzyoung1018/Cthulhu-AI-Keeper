// 玩家行动检测器：在发送给 AI 之前，检测是否需要触发对抗/技能检定。
// 匹配后立即掷骰，结果先广播给玩家，再传给 AI 作为叙事上下文。

const SOCIAL_PATTERNS = [
  { pattern: /欺诈|欺骗|撒谎|说谎|骗过去|哄过去|忽悠|隐瞒|伪装|冒充|假称|编造|扯谎|瞎说|蒙混|糊弄/, skill: '话术', contestType: 'social', label: '欺诈检定' },
  { pattern: /恐吓|威胁|吓唬|警告.*不然|再.*杀|放狠话/, skill: '恐吓', contestType: 'social', label: '恐吓检定' },
  { pattern: /说服|劝服|求情|讲道理|谈条件|讨价还价|游说/, skill: '说服', contestType: 'social', label: '说服检定' },
  { pattern: /魅惑|勾引|调情|献媚|示好.*套话/, skill: '魅惑', contestType: 'social', label: '魅惑检定' },
  { pattern: /套话|打听.*消息|探.*口风|旁敲侧击|套.*情报/, skill: '话术', contestType: 'social', label: '套话检定' },
  { pattern: /过.*检定|过欺诈|过恐吓|过说服|过魅惑|过话术/, skill: null, contestType: 'social', label: '社交检定' },
];

// 从消息文本检测社交对抗
export function detectSocialContest(content, characterSheet) {
  const text = String(content || '');
  for (const entry of SOCIAL_PATTERNS) {
    if (entry.pattern.test(text)) {
      // 如果条目没指定 skill，尝试从括号提取
      let skill = entry.skill;
      if (!skill) {
        const m = text.match(/过(\S{1,4})?检定/);
        if (m) {
          const word = m[1] || '';
          const map = { 欺诈: '话术', 恐吓: '恐吓', 说服: '说服', 魅惑: '魅惑', 话术: '话术' };
          skill = map[word] || '话术';
        } else {
          skill = '话术';
        }
      }
      // 检查玩家是否有该技能
      const skillValue = characterSheet?.skills?.[skill] || 0;
      if (skillValue > 0) {
        return { ...entry, skill, skillValue };
      }
      // 技能值为0也允许（用基础值）
      return { ...entry, skill, skillValue: Math.max(skillValue, 1) };
    }
  }
  return null;
}

const STEALTH_PATTERNS = [
  { pattern: /潜入|偷偷|悄悄|蹑手|溜进|摸进|潜行|不被发现|跟踪|尾随|暗中/, skill: '潜行', contestType: 'stealth', label: '潜行检定' },
  { pattern: /乔装|伪装|变装|化妆.*成|扮成|冒充/, skill: '乔装', contestType: 'stealth', label: '乔装检定' },
  { pattern: /偷|扒窃|顺手|摸走|盗窃/, skill: '妙手', contestType: 'stealth', label: '妙手检定' },
];

export function detectStealthContest(content, characterSheet) {
  const text = String(content || '');
  for (const entry of STEALTH_PATTERNS) {
    if (entry.pattern.test(text)) {
      const skillValue = characterSheet?.skills?.[entry.skill] || 0;
      return { ...entry, skillValue };
    }
  }
  return null;
}

const COMBAT_PATTERNS = [
  { pattern: /刺杀|暗杀|偷袭|突袭|先手|发动攻击|开枪|射击|捅/, skill: '格斗', contestType: 'combat', label: '战斗检定' },
];

export function detectCombatContest(content, characterSheet) {
  const text = String(content || '');
  for (const entry of COMBAT_PATTERNS) {
    if (entry.pattern.test(text)) {
      const skillValue = characterSheet?.skills?.[entry.skill] || 0;
      return { ...entry, skillValue };
    }
  }
  return null;
}

// 统一检测：返回最高优先级的匹配
export function detectContestedAction(content, characterSheet) {
  return detectSocialContest(content, characterSheet)
    || detectStealthContest(content, characterSheet)
    || detectCombatContest(content, characterSheet)
    || null;
}
