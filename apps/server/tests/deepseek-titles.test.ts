import { test, expect } from 'bun:test'
import { createTitleClient, parseTitleResponse, TITLE_SYSTEM, TITLE_TASK } from '../src/packaging/titles'

const response = () => ({ candidates: ['新闻热点型','冲突悬念型','犀利观点型','行业趋势型','深度洞察型'].map((angle,i) => ({ title: `技术进步的产业影响${i}`, angle, evidenceIds:['a'] })), recommendedIndex:2, recommendationReason:'观点完整且忠实内容' })
test('DeepSeek 标题协议：五种角度、推荐、封面正文同文、依据校验', () => {
  const result = parseTitleResponse(response(),new Set(['a']))
  expect(result.candidates).toHaveLength(5)
  expect(result.candidates.filter(c=>c.recommended).map(c=>c.id)).toEqual(['title_3'])
  expect(result.candidates.every(c=>c.coverTitle===c.bodyTitle)).toBe(true)
  expect(()=>parseTitleResponse(response(),new Set(['b']))).toThrow('依据')
  expect(()=>parseTitleResponse({...response(),recommendedIndex:5},new Set(['a']))).toThrow('推荐')
})
test('DeepSeek 使用独立凭据、原始系统提示词及 JSON 请求；未配密钥明确报错', async () => {
  const before = {key:process.env.DEEPSEEK_API_KEY,base:process.env.DEEPSEEK_BASE_URL,model:process.env.DEEPSEEK_MODEL}
  let observed: any
  const server = Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req) {
    observed = {path:new URL(req.url).pathname,auth:req.headers.get('authorization'),body:await req.json()}
    return Response.json({choices:[{message:{content:JSON.stringify(response())},finish_reason:'stop'}]})
  }})
  try {
    process.env.DEEPSEEK_API_KEY='title-test-key';process.env.DEEPSEEK_BASE_URL=`http://127.0.0.1:${server.port}`;process.env.DEEPSEEK_MODEL='test-model'
    const calls: any[]=[]
    await createTitleClient(calls).ask('titles',TITLE_TASK,{},v=>parseTitleResponse(v,new Set(['a'])))
    expect(observed.path).toBe('/chat/completions')
    expect(observed.auth).toBe('Bearer title-test-key')
    expect(observed.body.messages[0].content).toBe(TITLE_SYSTEM)
    expect(observed.body.response_format.type).toBe('json_object')
    expect(calls[0].model).toBe('test-model')
    process.env.DEEPSEEK_API_KEY=''
    await expect(createTitleClient([]).ask('titles',TITLE_TASK,{},v=>v)).rejects.toThrow('DEEPSEEK_API_KEY')
  } finally {
    server.stop(true)
    for(const [name,value] of Object.entries({DEEPSEEK_API_KEY:before.key,DEEPSEEK_BASE_URL:before.base,DEEPSEEK_MODEL:before.model})) {
      if(value===undefined)delete process.env[name];else process.env[name]=value
    }
  }
})
