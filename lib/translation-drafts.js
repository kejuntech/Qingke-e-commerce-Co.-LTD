'use strict';
const LANGUAGES = Object.freeze({
  'zh-CN': 'Simplified Chinese', es: 'Spanish', fr: 'French', de: 'German',
  pt: 'Portuguese', ru: 'Russian', ar: 'Arabic', ko: 'Korean', ja: 'Japanese'
});
const FIELDS = ['name', 'description', 'category', 'subcategory', 'group'];
function safeText(value, max = 1200) { return String(value ?? '').trim().slice(0, max); }
function validateTranslationRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid translation request.');
  const product = input.product;
  if (!product || typeof product !== 'object' || Array.isArray(product)) throw new Error('Product details are required.');
  const clean = {};
  for (const key of FIELDS) clean[key] = safeText(product[key], key === 'description' ? 4000 : 300);
  if (!clean.name || !clean.description) throw new Error('Product name and description are required before drafting translations.');
  const specs = product.specs;
  if (!specs || typeof specs !== 'object' || Array.isArray(specs) || Object.keys(specs).length > 100) throw new Error('Technical specifications must be an object with no more than 100 entries.');
  clean.specs = {};
  for (const [key, value] of Object.entries(specs)) {
    const k = safeText(key, 180), v = safeText(value, 500);
    if (k) clean.specs[k] = v;
  }
  const languages = Array.isArray(input.languages) ? [...new Set(input.languages.map(String))] : [];
  if (!languages.length || languages.length > 9 || languages.some(code => !Object.hasOwn(LANGUAGES, code))) throw new Error('Choose one or more supported target languages.');
  return { product: clean, languages };
}
function numericTokens(value) { return String(value ?? '').match(/(?:\d+(?:[.,]\d+)?|\.\d+)(?:\s?%|\s?(?:kPa|MPa|Pa|bar|psi|PSI|°C|°F|mm|cm|m|km|in|inch|ft|kg|g|mg|L|mL|m³|V|mV|A|mA|Hz|kHz|MHz|W|kW|Ω|ohm|℃|℉))?/gi) || []; }
function validateDraft(draft, request) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('Translation provider returned an invalid draft.');
  const out = {};
  for (const lang of request.languages) {
    const item = draft[lang];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Translation draft is missing language ${lang}.`);
    out[lang] = {};
    for (const field of FIELDS) {
      const translated = safeText(item[field], field === 'description' ? 4000 : 300);
      if (translated) {
        const sourceNumbers = numericTokens(request.product[field]);
        if (sourceNumbers.some(token => !translated.toLowerCase().includes(token.toLowerCase()))) throw new Error(`Numeric or unit check failed for ${lang}.${field}; review the draft manually.`);
        out[lang][field] = translated;
      }
    }
    const translatedSpecs = item.specs;
    if (!translatedSpecs || typeof translatedSpecs !== 'object' || Array.isArray(translatedSpecs)) throw new Error(`Technical specification draft is invalid for ${lang}.`);
    out[lang].specs = {};
    for (const [key, sourceValue] of Object.entries(request.product.specs)) {
      const tr = translatedSpecs[key];
      if (!tr || typeof tr !== 'object' || Array.isArray(tr)) throw new Error(`Technical specification draft is missing ${lang}: ${key}.`);
      const name = safeText(tr.name, 180), value = safeText(tr.value, 500);
      if (name) out[lang].specs[key] = { name };
      if (value) {
        const sourceNumbers = numericTokens(sourceValue);
        if (sourceNumbers.some(token => !value.toLowerCase().includes(token.toLowerCase()))) throw new Error(`Numeric or unit check failed for ${lang} parameter value: ${key}; review the draft manually.`);
        out[lang].specs[key] = { ...(out[lang].specs[key] || {}), value };
      }
    }
  }
  return out;
}
function buildPrompt(request) {
  return [
    'You are a professional translator for industrial instrumentation and B2B product catalogs.',
    'Return ONLY a valid JSON object. Do not use markdown fences or add commentary.',
    'Translate all supplied fields to every requested language. Preserve product model names, SKU-like identifiers, numbers, decimal punctuation where possible, symbols, measurement units, accuracy, ranges, and technical meaning exactly. Never invent specifications.',
    'For each language code, return fields name, description, category, subcategory, group, and specs. specs must map each original spec key to {"name":"translated parameter name","value":"translated value"}. Keep every original spec key unchanged as the JSON key. If a value is only a number/unit or code, copy it exactly rather than translating it. For mixed text values, translate words but preserve all numeric/unit tokens.',
    'Target languages: ' + request.languages.map(code => `${code} (${LANGUAGES[code]})`).join(', '),
    'Source product JSON: ' + JSON.stringify(request.product)
  ].join('\n');
}
module.exports = { LANGUAGES, validateTranslationRequest, validateDraft, buildPrompt, numericTokens };
