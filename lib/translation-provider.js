'use strict';
const MAX_PROBE_RESPONSE_BYTES = 256 * 1024;
async function readProbeJson(response) {
  const declared = Number(response?.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_PROBE_RESPONSE_BYTES) throw new Error('Probe response too large');
  if (typeof response?.text === 'function') {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_PROBE_RESPONSE_BYTES) throw new Error('Probe response too large');
    try { return JSON.parse(raw); } catch { return null; }
  }
  if (typeof response?.json === 'function') return response.json().catch(() => null);
  return null;
}
function translationConfig(env = process.env) {
  const endpoint=String(env.TRANSLATION_API_URL||'').trim();
  const apiKey=String(env.TRANSLATION_API_KEY||'').trim();
  const model=String(env.TRANSLATION_MODEL||'').trim();
  if(!endpoint||!apiKey||!model) return {configured:false, reason:'请在 Render 环境变量中配置翻译接口地址、密钥和模型名称。'};
  let url;
  try { url=new URL(endpoint); } catch { return {configured:false, reason:'翻译接口地址格式无效。'}; }
  if(url.protocol!=='https:') return {configured:false, reason:'翻译接口必须使用 HTTPS。'};
  if(url.username||url.password) return {configured:false, reason:'请勿将用户名或密码嵌入接口 URL。'};
  return {configured:true, endpoint:url.toString(), apiKey, model};
}
async function probeTranslationProvider({env=process.env, fetchImpl=globalThis.fetch}={}) {
  const cfg=translationConfig(env);
  if(!cfg.configured) return {ok:false, configured:false, message:cfg.reason};
  if(typeof fetchImpl!=='function') return {ok:false, configured:true, message:'当前 Node 环境不支持 fetch。'};
  try {
    const response=await fetchImpl(cfg.endpoint,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+cfg.apiKey,'Content-Type':'application/json'},body:JSON.stringify({model:cfg.model,temperature:0,response_format:{type:'json_object'},messages:[{role:'system',content:'Return a JSON object only, with a single boolean property "ok" set to true.'},{role:'user',content:'This is a connectivity check only. Do not translate or return any product data. Return {"ok":true}.'}]}),signal:AbortSignal.timeout(15000)});
    let payload;
    try { payload=await readProbeJson(response); } catch { return {ok:false,configured:true,message:'翻译服务响应过大或无法读取；请检查服务商兼容性。'}; }
    if(!response.ok) return {ok:false,configured:true,message:'翻译服务拒绝了测试请求。请检查接口地址、模型和 API 密钥。'};
    let result;
    try { result=JSON.parse(payload?.choices?.[0]?.message?.content||''); } catch { return {ok:false,configured:true,message:'服务已响应，但未返回预期的 JSON 格式；请检查服务商兼容性。'}; }
    if(result?.ok!==true) return {ok:false,configured:true,message:'服务已响应，但返回内容未通过连接检查。'};
    return {ok:true,configured:true,message:'翻译服务连接成功。测试仅发送了连接检查文本，没有发送或修改产品数据。'};
  } catch {
    return {ok:false,configured:true,message:'无法连接翻译服务。请检查网络、HTTPS 接口地址和服务状态。'};
  }
}
module.exports={translationConfig,probeTranslationProvider,readProbeJson,MAX_PROBE_RESPONSE_BYTES};
