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

  return {
    loadConfig,
    saveConfig,
    maskConfig,
    configFile,
  };
}

module.exports = { PROTOCOLS, PROVIDER_PRESETS, DEFAULT_CONFIG, createAiGateway, normalizeConfig, maskConfig };
