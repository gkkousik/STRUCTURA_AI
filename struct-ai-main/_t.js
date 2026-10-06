const axios=require('./node_modules/axios');
process.chdir('/home/claude/struct-ai-main');
process.env.GROQ_API_KEY='k1,k2'; process.env.GEMINI_API_KEY='g1';
const orig=axios.post;
axios.post=(url,body,cfg)=>orig(url.includes('groq')?'http://localhost:9911/a':'http://localhost:9911/b',body,cfg);
const {generateAiSyntax}=require('/home/claude/struct-ai-main/utils/groq');
generateAiSyntax('Demo','Sequence Diagram','').then(r=>console.log('RESULT:\n'+r)).catch(e=>console.log('FAIL',e.message)).finally(()=>process.exit());
