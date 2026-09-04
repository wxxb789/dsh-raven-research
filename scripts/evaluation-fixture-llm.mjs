import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

let nextCall = 0

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(code) {
  const id = ToolCallId(`raven-evaluation-fixture-${++nextCall}`)
  const args = JSON.stringify({ code, description: 'Drive deterministic Raven lifecycle smoke' })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'run_code', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'run_code', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function latestHumanMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || message.source?.kind !== 'user') continue
    return {
      index,
      text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    }
  }
  return { index: -1, text: '' }
}

function calledAfter(messages, index) {
  return messages.slice(index + 1).some(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'tool-call' && block.name === 'run_code'))
}

function taskId(messages) {
  const text = messages.flatMap(message => message.role === 'user'
    ? message.content.flatMap(block => block.type === 'tool-result'
      ? block.content.filter(item => item.type === 'text').map(item => item.text)
      : [])
    : []).join('\n')
  return /rvn-[a-f0-9]{12}-\d+/u.exec(text)?.[0]
}

function lifecycleCode(prompt, id) {
  if (id === undefined) {
    return [
      'const started = await tools.raven_task({ action: "start", outcome: "general-writing", request: "Deterministic evaluation lifecycle smoke.", grounding: "none", structureMode: "skip" });',
      'return tools.raven_task({ action: "checkpoint", taskId: started.state.taskId, stage: "draft", summary: "Fixture checkpoint one.", artifact: "Fixture checkpoint one." });',
    ].join('\n')
  }
  if (prompt.includes('prioritize reconstruction')) {
    const prefix = `await tools.raven_task({ action: "steer", taskId: ${JSON.stringify(id)}, correction: "Prioritize reconstruction risk." });\nawait tools.raven_task({ action: "checkpoint", taskId: ${JSON.stringify(id)}, stage: "refine", summary: "Fixture checkpoint two.", artifact: "Fixture checkpoint two." });`
    return prompt.includes('stop the same Task')
      ? `${prefix}\nreturn tools.raven_task({ action: "stop", taskId: ${JSON.stringify(id)}, reason: "Fixture process restart." });`
      : `${prefix}\nreturn tools.raven_task({ action: "status", taskId: ${JSON.stringify(id)} });`
  }
  if (prompt.includes('Stop here')) {
    return `return tools.raven_task({ action: "stop", taskId: ${JSON.stringify(id)}, reason: "Fixture process restart." });`
  }
  return `await tools.raven_task({ action: "resume", taskId: ${JSON.stringify(id)} });\nawait tools.raven_task({ action: "checkpoint", taskId: ${JSON.stringify(id)}, stage: "refine", summary: "Fixture final checkpoint.", artifact: "Fixture completed artifact." });\nreturn tools.raven_task({ action: "complete", taskId: ${JSON.stringify(id)}, artifact: "Fixture completed artifact." });`
}

class EvaluationFixtureAdapter extends LlmAdapter {
  async * stream(options) {
    const human = latestHumanMessage(options.messages)
    const raven = String(options.system ?? '').includes('raven_task')
    const chunks = raven && !calledAfter(options.messages, human.index)
      ? toolChunks(lifecycleCode(human.text, taskId(options.messages)))
      : textChunks('EVALUATION_FIXTURE_RUN_OK')
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

export const name = 'raven-evaluation-fixture-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new EvaluationFixtureAdapter())
}
