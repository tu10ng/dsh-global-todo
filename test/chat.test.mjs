import { strict as assert } from 'node:assert'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CHAT_SUMMARY,
  MAX_CHAT_TEXT,
  chatTranscriptFromEvents,
  createChat,
  summarizeToolCall,
} from '../lib/chat.js'

/** A recording stand-in for the host's `agents` service, shared shape with dispatch.test. */
function makeAgents() {
  const sessions = new Map()
  const created = []
  return {
    created,
    sessions,
    async create(options) {
      created.push(options)
      // The Host composes the session by calling `setup` before the agent runs.
      if (typeof options.setup === 'function') await options.setup({})
      const sent = []
      const agent = {
        id: options.sessionId,
        status: 'idle',
        options: options.agentOptions,
        sent,
        followup(message) {
          sent.push({ kind: 'followup', message })
        },
        steer(message) {
          sent.push({ kind: 'steer', message })
        },
      }
      sessions.set(options.sessionId, agent)
      return { agent }
    },
    get(id) {
      return sessions.get(id)
    },
    resumed: [],
    resumeFails: false,
    known: new Set(['session-dormant']),
    async resume(options) {
      this.resumed.push(options.resumeSessionId)
      if (this.resumeFails || !this.known.has(options.resumeSessionId)) {
        throw new Error(`session "${options.resumeSessionId}" not found`)
      }
      const sent = []
      const agent = {
        id: options.resumeSessionId,
        status: 'idle',
        sent,
        followup(message) {
          sent.push({ kind: 'followup', message })
        },
        steer(message) {
          sent.push({ kind: 'steer', message })
        },
      }
      sessions.set(options.resumeSessionId, agent)
      return { agent }
    },
  }
}

function makeCtx(services = {}) {
  const table = {
    agents: services.agents,
    agentPresets: services.presets,
    agentDefaultModel: services.defaults,
    sessionQuery: services.sessionQuery,
  }
  const root = { get: (name) => table[name] }
  return { root, get: root.get }
}

async function harness(services = {}, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-chat-'))
  const warnings = []
  const chat = createChat({
    ctx: makeCtx(services),
    logger: { warn: (message) => warnings.push(message), info() {} },
    settings: { get: () => ({ chatDir: options.chatDir ?? '' }) },
    file: path.join(dir, 'chat-session.json'),
  })
  return {
    chat,
    dir,
    warnings,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** The sidecar load and the backfill it triggers are both async; give them a beat. */
const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

test('a tool trace is one zh line, and read-only tools are no line at all', () => {
  const todo = (seq) => ({ seq, title: '修登录页' })
  assert.equal(summarizeToolCall('global_todo_list', {}, { ok: true }), '')
  assert.equal(summarizeToolCall('global_todo_get', { id: 't-1' }, { ok: true, todo: todo(3) }), '')
  assert.equal(summarizeToolCall('not_a_todo_tool', {}, undefined), '')
  assert.equal(summarizeToolCall('global_todo_add', { title: '修登录页' }, { ok: true, todo: todo(13) }), '新增 #13「修登录页」')
  assert.equal(summarizeToolCall('global_todo_add', { title: '修登录页' }, undefined), '新增「修登录页」')
  assert.equal(summarizeToolCall('global_todo_add', {}, undefined), '新增 1 条待办')
  assert.equal(
    summarizeToolCall('global_todo_capture', { items: [{}, {}, {}, {}] }, { ok: true, count: 3, skipped: [{}, {}] }),
    '批量登记 3 条，跳过 2 条',
  )
  assert.equal(
    summarizeToolCall('global_todo_update', { priority: 'high', status: 'doing' }, { ok: true, todo: todo(12) }),
    '修改了 #12：优先级→P1 高、状态→进行中',
  )
  assert.equal(
    summarizeToolCall('global_todo_update', { dueAt: null }, undefined),
    '修改了：截止',
  )
  assert.equal(summarizeToolCall('global_todo_link', { id: 't-1', add: [{ value: 'https://x' }] }, { ok: true, todo: todo(8) }), '给 #8挂了 1 个附件')
  assert.equal(summarizeToolCall('global_todo_note', { id: 't-1', text: 'x' }, { ok: true, todo: todo(8) }), '给 #8记了进展')
  assert.equal(summarizeToolCall('global_todo_done', { id: 't-1' }, { ok: true, todo: todo(9) }), '完成 #9')
  assert.equal(summarizeToolCall('global_todo_done', { id: 't-1', status: 'doing' }, { ok: true, todo: todo(9) }), '把 #9标成 进行中')
  assert.equal(summarizeToolCall('global_todo_reopen', { id: 't-1' }, { ok: true, todo: todo(9) }), '把 #9标回未完成')
  assert.equal(summarizeToolCall('global_todo_remove', { id: 't-1' }, { ok: true, title: '旧任务' }), '删除「旧任务」')
  assert.equal(
    summarizeToolCall('global_todo_remove', { id: 't-1' }, { ok: false, reason: 'not-found', error: '找不到这条待办' }),
    '调用 remove 失败：找不到这条待办',
  )
})

test('a transcript is rebuilt from the log it keeps, and says what it cannot know', () => {
  // The two event shapes are asymmetric in the Host's log (verified on 0.2.1):
  // assistant/message nests the message under `data.message`, user/message
  // carries the message **as** `data`. One shape for both silently dropped the
  // person's half of every rebuilt transcript.
  const events = [
    { type: 'user/message', seq: 1, time: 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '一个人打的字' }] } },
    { type: 'user/message', seq: 2, time: 110, data: { source: { kind: 'plugin:dsh-global-todo' }, content: [{ type: 'text', text: '把重要的清一遍' }] } },
    { type: 'assistant/message', seq: 3, time: 120, data: { message: { content: [{ type: 'text', text: '好，先看一下。' }] } } },
    { type: 'tool/call', seq: 4, time: 130, data: { name: 'global_todo_list' } },
    { type: 'tool/call', seq: 5, time: 140, data: { name: 'global_todo_update', args: { priority: 'high' } } },
    { type: 'tool/call', seq: 6, time: 150, data: { name: 'some_other_tool' } },
    { type: 'assistant/message', seq: 7, time: 160, data: { message: { content: [{ type: 'text', text: '改好了。' }] } } },
    { type: 'turn/end', seq: 8, time: 170, data: { reason: { kind: 'interrupted' } } },
    'junk',
  ]
  const rows = chatTranscriptFromEvents(events, { limit: 10, now: () => 999 })
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['user', 'assistant', 'tool', 'assistant', 'note'],
  )
  assert.equal(rows[0].text, '把重要的清一遍', 'the person line survives the rebuild')
  // The rebuilt tool line degrades honestly: no result means no #seq and no ok.
  assert.equal(rows[2].text, '修改了：优先级→P1 高')
  assert.equal(rows[2].ok, undefined)
  // A person's message never belongs to this room.
  assert.ok(rows.every((row) => row.text !== '一个人打的字'))
  // The cap keeps the tail.
  assert.equal(chatTranscriptFromEvents(events, { limit: 2 }).length, 2)
})

test('the first line creates the session: preamble in a block array, empty preset mounted, sidecar written', async () => {
  const agents = makeAgents()
  const resolved = []
  const mounted = []
  const registered = []
  const presets = {
    register: (definition) => {
      registered.push(definition)
    },
    resolve: async (id) => {
      resolved.push(id)
      return { id: id ?? 'standard' }
    },
    mount: async (agentCtx, id) => {
      mounted.push(id)
    },
  }
  const chatHome = await mkdtemp(path.join(tmpdir(), 'gt-chat-home-'))
  const env = await harness({ agents, presets }, { chatDir: chatHome })
  try {
    const outcome = await env.chat.send('把过期的都归档')
    assert.equal(outcome.sent, true)
    assert.equal(outcome.fresh, true)
    assert.equal(agents.created.length, 1)
    const options = agents.created[0]
    assert.equal(options.meta.cwd, chatHome)
    // The butler's own preset: an empty plugin list, because the Host's `minimal`
    // carries a shell and the butler must not have one.
    assert.equal(options.meta.agentPreset, 'dsh-global-todo:butler')
    assert.equal(registered.length, 1)
    assert.deepEqual(registered[0].plugins, [])
    assert.deepEqual(mounted, ['dsh-global-todo:butler'])
    const message = agents.sessions.get(options.sessionId).sent[0].message
    assert.equal(message.role, 'user')
    assert.ok(Array.isArray(message.content), 'a bare string corrupts the session record')
    assert.match(message.content[0].text, /全局待办.*管家/)
    assert.match(message.content[0].text, /把过期的都归档/)
    assert.equal(message.source.kind, 'plugin:dsh-global-todo')
    assert.equal(message.source.summary, CHAT_SUMMARY)
    await settle()
    const sidecar = JSON.parse(await readFile(path.join(env.dir, 'chat-session.json'), 'utf8'))
    assert.equal(sidecar.id, options.sessionId)
    assert.equal(env.chat.sessionId(), options.sessionId)
  } finally {
    await env.cleanup()
    await rm(chatHome, { recursive: true, force: true })
  }
})

test('the working directory defaults to home, never to the store', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    await env.chat.send('随便看看')
    assert.equal(agents.created[0].meta.cwd, homedir())
  } finally {
    await env.cleanup()
  }
})

test('the second line carries no preamble and never steers', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    await env.chat.send('第一条')
    await env.chat.send('第二条')
    assert.equal(agents.created.length, 1, 'the session is persistent')
    const agent = agents.sessions.get(agents.created[0].sessionId)
    assert.equal(agent.sent.length, 2)
    assert.ok(agent.sent.every((entry) => entry.kind === 'followup'))
    assert.doesNotMatch(agent.sent[1].message.content[0].text, /管家/)
  } finally {
    await env.cleanup()
  }
})

test('a busy butler refuses the line instead of interrupting itself', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    await env.chat.send('第一条')
    const sessionId = env.chat.sessionId()
    // Busy sense one: the turn has started and not ended.
    env.chat.handleEvent({ id: sessionId }, { type: 'turn/start' })
    await assert.rejects(() => env.chat.send('插队'), (error) => error.code === 'chat-busy')
    env.chat.handleEvent({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    // Busy sense two: the live agent reports itself running.
    agents.sessions.get(sessionId).status = 'running'
    assert.equal(env.chat.state().running, true)
    await assert.rejects(() => env.chat.send('再插一次'), (error) => error.code === 'chat-busy')
  } finally {
    await env.cleanup()
  }
})

test('a host without agents answers cannot-send, not a crash', async () => {
  const env = await harness({})
  try {
    const state = env.chat.state()
    assert.equal(state.canSend, false)
    assert.equal(state.sessionId, '')
    await assert.rejects(() => env.chat.send('有人吗'), (error) => error.code === 'agents-unavailable')
    assert.deepEqual(env.warnings, [])
  } finally {
    await env.cleanup()
  }
})

test('an empty or oversized line is refused before anything is created', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    await assert.rejects(() => env.chat.send('   '), (error) => error.code === 'invalid-body')
    await assert.rejects(() => env.chat.send('x'.repeat(MAX_CHAT_TEXT + 1)), (error) => error.code === 'invalid-body')
    await assert.rejects(() => env.chat.send(7), (error) => error.code === 'invalid-body')
    assert.equal(agents.created.length, 0)
  } finally {
    await env.cleanup()
  }
})

test('the person line is echoed locally, once, whatever the feed does', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    // The user entry is the local copy: the live feed broadcasts the butler's
    // turns but not the notices this plugin injects (verified on 0.2.1), so an
    // event-driven echo would silently never arrive.
    env.chat.setWatching(true)
    await env.chat.send('本地回显')
    const sessionId = env.chat.sessionId()
    const sent = agents.sessions.get(sessionId).sent[0].message
    // A user/message event — even ours — is not a second copy.
    env.chat.handleEvent({ id: sessionId }, { type: 'user/message', data: { source: sent.source, message: { content: sent.content } } })
    const userEntries = env.chat.state().messages.filter((entry) => entry.kind === 'user')
    assert.equal(userEntries.length, 1)
    assert.equal(userEntries[0].text, '本地回显', 'the preamble is transport, not transcript')
  } finally {
    await env.cleanup()
  }
})

test('a host that cannot register presets gets a preset-less butler, never a heavier one', async () => {
  const agents = makeAgents()
  const presets = {
    // No `register`; `resolve` answers only the standard presets — a chain that
    // must NOT be walked, because `standard` carries a shell.
    resolve: async (id) => (id === undefined ? { id: 'standard' } : Promise.reject(new Error('unknown'))),
    mount: async () => undefined,
  }
  const env = await harness({ agents, presets })
  try {
    await env.chat.send('没有预设也要能干活')
    const options = agents.created[0]
    assert.equal(options.meta.agentPreset, undefined, 'no preset at all rather than one with tools')
    assert.equal(options.setup, undefined)
  } finally {
    await env.cleanup()
  }
})

test('assistant replies and aborted turns land in the transcript', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    await env.chat.send('改一下')
    const sessionId = env.chat.sessionId()
    env.chat.handleEvent({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正在改' }] } } })
    env.chat.handleEvent({ id: sessionId }, { type: 'tool/call', data: { name: 'global_todo_update' } })
    env.chat.handleEvent({ id: 'some-other-session' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '别处的消息' }] } } })
    env.chat.handleEvent({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    const kinds = env.chat.state().messages.map((entry) => entry.kind)
    assert.deepEqual(kinds, ['user', 'assistant', 'note'])
    assert.match(env.chat.state().messages.at(-1).text, /没有正常结束/)
    assert.equal(env.chat.state().running, false)
  } finally {
    await env.cleanup()
  }
})

test('tool traces record where the tool ran, and never cost the call', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    await env.chat.send('帮我改')
    const sessionId = env.chat.sessionId()
    env.chat.recordTool({
      name: 'global_todo_update',
      args: { status: 'doing' },
      origin: { sessionId: 'session-somebody-else' },
      value: { ok: true, todo: { seq: 4 } },
    })
    assert.equal(env.chat.state().messages.length, 1, 'a tool another session called is not our business')
    env.chat.recordTool({
      name: 'global_todo_done',
      origin: { sessionId },
      value: { ok: true, todo: { seq: 4, title: '对齐版本号' } },
    })
    const trace = env.chat.state().messages.at(-1)
    assert.equal(trace.kind, 'tool')
    assert.equal(trace.ok, true)
    assert.equal(trace.text, '完成 #4')
    // A malformed call must not throw out of the wrapper.
    env.chat.recordTool(null)
    env.chat.recordTool({ name: undefined, origin: { sessionId } })
    assert.equal(env.chat.state().messages.length, 2)
  } finally {
    await env.cleanup()
  }
})

test('a session that cannot come back is replaced, visibly', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    await env.chat.send('第一段')
    const first = env.chat.sessionId()
    agents.sessions.delete(first)
    agents.known.delete(first)
    const outcome = await env.chat.send('接着来')
    assert.equal(outcome.fresh, true)
    assert.equal(agents.created.length, 2)
    const notes = env.chat.state().messages.filter((entry) => entry.kind === 'note')
    assert.equal(notes.length, 1)
    assert.match(notes[0].text, /已不可用/)
    assert.deepEqual(agents.resumed, [first])
  } finally {
    await env.cleanup()
  }
})

test('reset forgets the session but leaves it alive', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    await env.chat.send('旧会话')
    const old = env.chat.sessionId()
    const state = env.chat.reset()
    assert.equal(state.sessionId, '')
    assert.equal(state.canSend, true)
    assert.deepEqual(state.messages, [])
    assert.ok(agents.sessions.has(old), 'the application owns the old session')
    await settle()
    const sidecar = JSON.parse(await readFile(path.join(env.dir, 'chat-session.json'), 'utf8'))
    assert.equal(sidecar.id, '')
    await env.chat.send('新会话')
    assert.notEqual(env.chat.sessionId(), old)
    assert.equal(agents.created.length, 2)
  } finally {
    await env.cleanup()
  }
})

test('a stored session id is loaded and its transcript rebuilt', async () => {
  const agents = makeAgents()
  const events = [
    { type: 'user/message', seq: 1, time: 100, data: { source: { kind: 'plugin:dsh-global-todo' }, message: { content: [{ type: 'text', text: '昨晚的请求' }] } } },
    { type: 'assistant/message', seq: 2, time: 200, data: { message: { content: [{ type: 'text', text: '昨晚的回复' }] } } },
  ]
  const sessionQuery = { readSession: async () => ({ events }) }
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-chat-load-'))
  try {
    await writeFile(path.join(dir, 'chat-session.json'), JSON.stringify({ id: 'session-back' }), 'utf8')
    const warnings = []
    const chat = createChat({
      ctx: makeCtx({ agents, sessionQuery }),
      logger: { warn: (message) => warnings.push(message), info() {} },
      settings: { get: () => ({}) },
      file: path.join(dir, 'chat-session.json'),
    })
    await settle()
    assert.equal(chat.sessionId(), 'session-back')
    assert.deepEqual(chat.state().messages.map((entry) => entry.text), ['昨晚的请求', '昨晚的回复'])
    assert.deepEqual(warnings, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rebuild that ends on an unanswered line says so', async () => {
  const agents = makeAgents()
  const events = [
    { type: 'user/message', seq: 1, time: 100, data: { source: { kind: 'plugin:dsh-global-todo' }, message: { content: [{ type: 'text', text: '还没回的话' }] } } },
  ]
  const sessionQuery = { readSession: async () => ({ events }) }
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-chat-cut-'))
  try {
    await writeFile(path.join(dir, 'chat-session.json'), JSON.stringify({ id: 'session-cut' }), 'utf8')
    const chat = createChat({
      ctx: makeCtx({ agents, sessionQuery }),
      logger: { warn() {}, info() {} },
      settings: { get: () => ({}) },
      file: path.join(dir, 'chat-session.json'),
    })
    await settle()
    const messages = chat.state().messages
    assert.equal(messages.length, 2)
    assert.equal(messages.at(-1).kind, 'note')
    assert.match(messages.at(-1).text, /还没有回复/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no query service and an unreadable sidecar both degrade silently', async () => {
  const agents = makeAgents()
  const env = await harness({ agents })
  try {
    await env.chat.backfill()
    assert.deepEqual(env.warnings, [], 'an absent service is a state, not a failure')
  } finally {
    await env.cleanup()
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-chat-broken-'))
  try {
    await writeFile(path.join(dir, 'chat-session.json'), '{ broken', 'utf8')
    const warnings = []
    const chat = createChat({
      ctx: makeCtx({ agents }),
      logger: { warn: (message) => warnings.push(message), info() {} },
      settings: { get: () => ({}) },
      file: path.join(dir, 'chat-session.json'),
    })
    await settle()
    assert.equal(chat.sessionId(), '', 'a corrupt sidecar is treated as absent')
    assert.deepEqual(warnings, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
