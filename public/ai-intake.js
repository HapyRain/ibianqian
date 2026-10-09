/**
 * 需求介入状态机（纯函数，前端与测试共用）。
 * 浏览器：window.AiIntake；Node：module.exports。
 * 三把尺子：AI 只提案；一切输出须人确认；纵向帮人不比人。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AiIntake = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createAiIntakeState() {
    return {
      draft: '',
      originalDraft: '',
      candidates: [],
      picked: null,
      pickedRound: 0,
      rounds: 0,
      rejected: 0,
      edited: false,
      draftHidden: false,
    };
  }

  /**
   * action:
   *  { type: 'reset' }
   *  { type: 'setDraft', draft: string }
   *  { type: 'expandStart' } / { type: 'expandOk', candidates: string[] } / { type: 'expandFail' }
   *  { type: 'pick', text: string }        // 选它
   *  { type: 'half', text: string }        // 对一半：扔回输入框可改，可再介入
   *  { type: 'reject', text: string }      // 完全不是
   *  { type: 'rejectAll' }                 // 一轮全否
   *  { type: 'editFinal' }                 // 定稿经过手动修改
   *  { type: 'hideDraft', hidden: boolean }
   */
  function nextAiState(state, action) {
    const s = { ...state, candidates: [...(state.candidates || [])] };
    const a = action || {};
    switch (a.type) {
      case 'reset':
        return createAiIntakeState();
      case 'setDraft':
        s.draft = typeof a.draft === 'string' ? a.draft : s.draft;
        // 手动改写定稿 → 标记 edited（若已有 picked）
        if (s.picked != null && s.draft !== s.picked) s.edited = true;
        return s;
      case 'expandStart':
        s.candidates = [];
        return s;
      case 'expandOk': {
        const list = Array.isArray(a.candidates) ? a.candidates.filter((x) => typeof x === 'string' && x.trim()) : [];
        s.candidates = list.map((x) => x.trim());
        if (!s.originalDraft) s.originalDraft = s.draft;
        s.rounds = (s.rounds || 0) + 1;
        return s;
      }
      case 'expandFail':
        s.candidates = [];
        return s;
      case 'pick': {
        const text = typeof a.text === 'string' ? a.text : '';
        if (!text.trim()) return s;
        s.picked = text.trim();
        s.draft = text.trim();
        s.edited = false;
        if (!s.pickedRound) s.pickedRound = s.rounds || 1;
        s.candidates = s.candidates.filter((c) => c !== text.trim());
        return s;
      }
      case 'half': {
        const text = typeof a.text === 'string' ? a.text : '';
        if (!text.trim()) return s;
        s.draft = text.trim();
        s.edited = true;
        s.candidates = s.candidates.filter((c) => c !== text.trim());
        return s;
      }
      case 'reject': {
        const text = typeof a.text === 'string' ? a.text : '';
        s.candidates = s.candidates.filter((c) => c !== text.trim());
        s.rejected = (s.rejected || 0) + 1;
        return s;
      }
      case 'rejectAll': {
        s.rejected = (s.rejected || 0) + (s.candidates ? s.candidates.length : 0);
        s.candidates = [];
        // 一轮全否仍记 rounds（否定也是排除法）
        if (!s.rounds) s.rounds = 1;
        return s;
      }
      case 'editFinal':
        s.edited = true;
        return s;
      case 'hideDraft':
        s.draftHidden = !!a.hidden;
        return s;
      default:
        return s;
    }
  }

  /** 构造 bug.aiTrace（仅当经过 AI 介入时由前端提交；定稿本体 = bug.name） */
  function buildAiTrace(state) {
    if (!state || !state.picked) return null;
    return {
      used: true,
      rounds: state.rounds || 1,
      draft: state.originalDraft || state.draft || '',
      draftHidden: !!state.draftHidden,
      picked: state.picked,
      pickedRound: state.pickedRound || 1,
      rejected: state.rejected || 0,
      edited: !!state.edited,
    };
  }

  return { createAiIntakeState, nextAiState, buildAiTrace };
});
