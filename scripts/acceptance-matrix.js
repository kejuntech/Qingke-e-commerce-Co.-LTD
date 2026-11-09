'use strict';
// Read-only, evidence-based release matrix. A passing unit suite never implies live readiness.
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const groups=[
 ['首页视觉像素级一致','browser-visual','需同视口参考图与实际截图像素对照'],
 ['后台可视化装修与保存','browser-db','需浏览器操作及数据库重新加载验证'],
 ['商品发布及SKU批量编辑','browser-db','需浏览器操作、刷新及数据一致性验证'],
 ['十种语言动态内容','live-translation','需真实翻译接口与十种语言逐页检查'],
 ['客户注册、购物车、订单','end-to-end','需独立测试环境端到端操作'],
 ['PayPal支付','paypal-sandbox','需沙盒授权、捕获与退款验证'],
 ['邮件通知','smtp-delivery','需真实收件箱确认'],
 ['PostgreSQL与上传文件持久化','restart-persistence','需测试环境重启、恢复和数据核对'],
 ['生产部署与回滚','production-release','需备份、部署、冒烟及回滚演练']
];
const evidence=process.env.KEJUN_ACCEPTANCE_EVIDENCE;
let verified={};
if(evidence){try{verified=JSON.parse(fs.readFileSync(evidence,'utf8'));}catch(e){console.error('无法读取验收证据：'+e.message);process.exit(2);}}
const items=groups.map(([name,key,required])=>({name,key,status:verified[key]?.verified===true && typeof verified[key]?.evidence==='string' && verified[key].evidence.trim()?'已提供验收证据':'待真实验收',required,evidence:verified[key]?.evidence||null}));
const report={project:'Qingke',generatedAt:new Date().toISOString(),note:'代码测试通过不代表实际业务验收；验收证据需独立核实。',items,ready:items.every(x=>x.status==='已提供验收证据')};
const dest=path.join(root,'reports','acceptance-matrix.json');
fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,JSON.stringify(report,null,2)+'\n');
console.log(items.map(x=>`${x.status} | ${x.name} | ${x.required}`).join('\n'));
console.log('报告: '+dest+'\n'+(report.ready?'所有项目均有验收证据，仍需人工审核':'尚未达到可宣布全面完成的标准'));
if(process.argv.includes('--strict')&&!report.ready)process.exitCode=1;
