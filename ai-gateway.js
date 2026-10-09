'use strict';
/**
 * AI 网关（M1+M4）：配置读写 + 协议适配 + 连通探测 + 串行调用队列 + 候选扩展 + 上下文预压缩。
 * 铁律：key 只落盘 {dataRoot}/ai.config.json，绝不写入 data.json，绝不进 WS 协议；
 *       对外只暴露 maskConfig 的掩码形态（key 只剩 keySet 标记）。
 */
const fs = require('fs');
const path = require('path');

const PROTOCOLS = ['openai', 'anthropic', 'gemini'];

// 厂商预设：baseUrl 只预填可从官方文档确认的地址；无法确认的预填 ''（用户手填）。
// modelHint 只填有把握的模型名，其余留空由用户填写——不确定的信息宁缺毋滥。
// ⚠️ 双份维护：public/app.js 的 AI_PRESET_BASE / AI_PRESET_MODEL / aiProviderOptions 与此同步，
//    新增/修改厂商时两处一起改（M2 可选改为 GET /api/ai/presets 由服务端单点下发）。
const PROVIDER_PRESETS = {
  mimo: { label: 'MiMo', protocol: 'openai', baseUrl: '', modelHint: '' },
  deepseek: { label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat' },
  glm: { label: 'GLM 智谱', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelHint: '' },
  qwen: { label: 'Qwen 通义', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelHint: '' },
  kimi: { label: 'Kimi 月之暗面', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', modelHint: '' },
  openai: { label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o-mini' },
  ollama: { label: 'Ollama 本地', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', modelHint: '' },
  custom: { label: '自定义', protocol: 'openai', baseUrl: '', modelHint: '' },
};

const DEFAULT_CONFIG = {
  enabled: false,
  provider: 'custom',
  protocol: 'openai',
  baseUrl: '',
  key: '',
  model: '',
  context: '',
  contextSummary: '',
};

function normalizeConfig(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const cfg = { ...DEFAULT_CONFIG };
  cfg.enabled = src.enabled === true;
  cfg.provider = (typeof src.provider === 'string' && src.provider) ? src.provider : 'custom';
  cfg.protocol = PROTOCOLS.includes(src.protocol) ? src.protocol : 'openai';
  cfg.baseUrl = typeof src.baseUrl === 'string' ? src.baseUrl.trim() : '';
  cfg.key = typeof src.key === 'string' ? src.key.trim() : '';
  cfg.model = typeof src.model === 'string' ? src.model.trim() : '';
  cfg.context = typeof src.context === 'string' ? src.context : '';
  cfg.contextSummary = typeof src.contextSummary === 'string' ? src.contextSummary : '';
  return cfg;
}

function assertSavable(cfg) {
  // key 非空（即将真正启用调用）时，baseUrl 必须是 http(s) 绝对地址；model 必填
  if (!cfg.key) return;
  if (!/^https?:\/\//.test(cfg.baseUrl)) {
    throw new Error('baseUrl 必须以 http:// 或 https:// 开头');
  }
  if (!cfg.model) {
    throw new Error('已填写 key 时 model 必填');
  }
}

function maskConfig(cfg) {
  return { ...cfg, key: '', keySet: typeof cfg.key === 'string' && cfg.key.length > 0 };
}

function createAiGateway({ dataRoot }) {
  if (!dataRoot || typeof dataRoot !== 'string') throw new Error('createAiGateway 需要 dataRoot');
  const configFile = path.join(dataRoot, 'ai.config.json');

  function loadConfig() {
    try {
      return normalizeConfig(JSON.parse(fs.readFileSync(configFile, 'utf-8')));
    } catch (e) {
      return normalizeConfig(null);
    }
  }

  function saveConfig(input) {
    const cfg = normalizeConfig(input);
    assertSavable(cfg);
    const tmp = configFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf-8');
    fs.renameSync(tmp, configFile);
    return cfg;
  }

  // 串行队列：任何并发 chat 都排队执行，防同一 key 并发打爆限流
  let _queue = Promise.resolve();
  function enqueue(task) {
    const run = _queue.then(() => task());
    _queue = run.then(() => {}, () => {});
    return run;
  }

  async function jsonFetch(url, options, redactKey) {
    const res = await fetch(url, options);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
    if (!res.ok) {
      let detail = (json && (json.error?.message || json.error || json.message)) || text.slice(0, 200);
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
      // 上游错误体可能原样回显请求内容——含 key 则脱敏，防凭据进日志/错误提示
      if (redactKey && typeof redactKey === 'string' && redactKey) detail = detail.split(redactKey).join('***');
      throw new Error(`模型请求失败 HTTP ${res.status}: ${detail}`);
    }
    return json;
  }

  async function chatOpenAICompat(cfg, opts) {
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const json = await jsonFetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, messages: opts.messages, max_tokens: opts.maxTokens ?? 1024 }),
    }, cfg.key);
    const content = json && json.choices && json.choices[0] && json.choices[0].message
      ? (json.choices[0].message.content || '') : '';
    return { content, raw: json };
  }

  async function chatAnthropic(cfg, opts) {
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const system = (opts.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
    const rest = (opts.messages || []).filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    const json = await jsonFetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: opts.maxTokens ?? 1024,
        ...(system ? { system } : {}),
        messages: rest,
      }),
    }, cfg.key);
    const content = (json && json.content || []).map(p => (p && p.text) || '').join('');
    return { content, raw: json };
  }

  async function chatGemini(cfg, opts) {
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const system = (opts.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
    const rest = (opts.messages || []).filter(m => m.role !== 'system').map(m => ({ ...m }));
    // 修正点B：gemini 无独立 system 字段——system 文本必须并入首条 user，否则展开提示词/项目背景全部丢失
    if (system && rest.length && rest[0].role === 'user') {
      rest[0] = { ...rest[0], content: system + '\n\n' + rest[0].content };
    } else if (system) {
      rest.unshift({ role: 'user', content: system });
    }
    const contents = rest.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const url = base + '/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent';
    const json = await jsonFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: opts.maxTokens ?? 1024 } }),
    }, cfg.key);
    const parts = (json && json.candidates && json.candidates[0] && json.candidates[0].content
      && json.candidates[0].content.parts) || [];
    return { content: parts.map(p => (p && p.text) || '').join(''), raw: json };
  }

  // 不入队的底层调用：读配置齐备性 → 按协议分流。已被 enqueue 包裹的调用方（expandDraft）只能用它。
  // ⚠️ 禁止在 enqueue 内调用 chat()——会二次入队：外层任务等内层、内层排在外层之后 = 死锁。
  async function chatRaw(cfg, opts) {
    if (!cfg.key || !cfg.baseUrl || !cfg.model) throw new Error('AI 配置不完整：baseUrl / key / model 均必填');
    if (cfg.protocol === 'anthropic') return chatAnthropic(cfg, opts);
    if (cfg.protocol === 'gemini') return chatGemini(cfg, opts);
    return chatOpenAICompat(cfg, opts);
  }

  // 对外唯一入口：始终经串行队列。
  // enabled 门控在路由层（/api/ai/expand）与前端入口；chat 本身不拦（testConnection 需要在 enabled=false 时可用）
  async function chat(opts) {
    return enqueue(() => chatRaw(loadConfig(), opts));
  }

  async function testConnection() {
    // 注意：走真实 chat(maxTokens:1)——会消耗一次最小计费调用，且排在串行队列在途请求之后，
    // UI「测试中」可能偏慢，属预期行为。
    const cfg = loadConfig();
    if (!cfg.baseUrl || !cfg.key || !cfg.model) {
      return { ok: false, latencyMs: 0, error: '配置不完整：baseUrl / key / model 均必填' };
    }
    const t0 = Date.now();
    try {
      await chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: e.message };
    }
  }

  return {
    loadConfig,
    saveConfig,
    maskConfig,
    configFile,
    chat,
    chatRaw,
    enqueue,
    testConnection,
  };
}

module.exports = { PROTOCOLS, PROVIDER_PRESETS, DEFAULT_CONFIG, createAiGateway, normalizeConfig, maskConfig };
