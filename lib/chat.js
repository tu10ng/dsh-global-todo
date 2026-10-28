/**
 * The chat butler: one persistent agent session that edits the todo list on request.
 *
 * The panel's chat bar is the door; this module is the room. One session, created
 * through `ctx.root` so the application owns it — the same rule a hand-off follows,
 * for the same reason: disabling or updating this plugin must not tear down a
 * conversation the person is having. The session is reused for every line, so the
 * butler remembers what it was asked before.
 *
 * The transcript lives in memory and is rebuilt from the session log on start when
 * the Host offers `sessionQuery`; without that service the room simply starts
 * empty — the session keeps its own history either way, and the first line after
 * a lost transcript re-carries the preamble so the butler still knows its role.
 *
 * Two rules worth keeping when changing this file:
 *
 * - **Never steer.** A second line while the butler is answering is rejected with
 *   `chat-busy`; interrupting its own turn would corrupt the very edits the person
 *   asked for. Queuing silently would look like the button did nothing.
 * - **One source of truth per entry.** User lines come back as `user/message`
 *   events and tool traces are recorded where the tool runs; neither is also
 *   pushed locally while the watcher is attached, or the transcript doubles.
 *
 * @module dsh-global-todo/chat
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'

import { messageText } from './completion.js'
import { CHAT_NOTICE_SOURCE, defaultModelSelection, noticeMessage } from './dispatch.js'
import { TodoError, asTodoError } from './errors.js'
import { PRIORITY_LABELS } from './model.js'

/** The `source.summary` every butler notice carries. */
export const CHAT_SUMMARY = '全局待办管家'

/**
 * The butler's own preset: an empty plugin list. A preset is a list of plugin
 * rows, and the butler needs none — the todo tools are registered host-globally.
 * Named here because the session header records it and a check must be able to
 * tell a butler session from any other at a glance.
 */
const BUTLER_PRESET = 'dsh-global-todo:butler'

/** Transcript cap. A conversation longer than this is a conversation to reset. */
export const MAX_TRANSCRIPT = 300

/** One line from the person, capped the way every text field here is. */
export const MAX_CHAT_TEXT = 4000

/** Tool names that only read; the assistant's reply already says what they found. */
const READ_TOOLS = new Set(['global_todo_list', 'global_todo_get'])

const STATUS_LABELS = {
  open: '未完成',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
  archived: '已归档',
}

/**
 * The role the first line of a fresh transcript carries. It travels as part of a
 * user turn (the Host has no plugin-facing way to add a system prompt to a session
 * another composition owns), so it states the rules as instructions to follow,
 * not as identity the butler can rely on later — which is why it repeats after a
 * lost transcript.
 */
const PREAMBLE = [
  '你是「全局待办」清单的管家。清单存在一个 JSON 文件里，人和 Agent 共用；你通过 global_todo_* 工具读写它，不要直接碰文件。',
  '规矩：',
  '- 动手前先用 global_todo_list / global_todo_get 看清楚现状，不确定就先问一句。',
  '- 修改用 global_todo_update，补充情况用 global_todo_note。',
  '- 没有得到明确允许，不要用 global_todo_remove 删除；不想要了就归档（status: archived）。',
  '- 做完后用一两句话汇报改了哪些条目（带 #序号）。',
].join('\n')

/** @param {string} name */
function shortToolName(name) {
  return name.startsWith('global_todo_') ? name.slice('global_todo_'.length) : name
}

/** @param {string} name */
function toolLabel(name) {
  return `${shortToolName(name)}`
}

/** Clip a title so one trace line stays one line. */
function clip(value, max = 24) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** `#12` when the result carries the record, '' when it does not (a backfilled trace). */
function refOf(todo) {
  const seq = Number(todo?.seq)
  return Number.isInteger(seq) && seq > 0 ? ` #${seq}` : ''
}

/** The record's title from a tool result, falling back to what was asked for. */
function titleFrom(todo, asked) {
  return clip(todo?.title) || clip(asked)
}

/**
 * The zh names of the fields an update touched, in the order a person reads them.
 *
 * @param {Record<string, unknown>} arg
 * @returns {string[]}
 */
function changedFields(arg) {
  const fields = []
  if (arg.title !== undefined) fields.push('标题')
  if (arg.description !== undefined) fields.push('描述')
  if (arg.priority !== undefined) {
    fields.push(`优先级→${PRIORITY_LABELS[arg.priority] ?? String(arg.priority)}`)
  }
  if (arg.status !== undefined) fields.push(`状态→${STATUS_LABELS[arg.status] ?? String(arg.status)}`)
  if (arg.dueAt !== undefined) fields.push('截止')
  if (arg.tags !== undefined) fields.push('标签')
  if (arg.steps !== undefined) fields.push('步骤')
  if (arg.links !== undefined) fields.push('附件')
  if (arg.evidence !== undefined) fields.push('原话')
  return fields
}

/**
 * One zh line describing what a tool call did, or `''` for a call that does not
 * deserve a line. `value` is the tool's return value — `{ ok: false, … }` names
 * the failure, a record names the row — and may be absent on a rebuilt trace,
 * where the line degrades to what the arguments alone can say.
 *
 * @param {string} name
 * @param {Record<string, unknown> | undefined} args
 * @param {Record<string, unknown> | undefined} value
 * @returns {string}
 */
export function summarizeToolCall(name, args, value) {
  if (typeof name !== 'string' || !name.startsWith('global_todo_')) return ''
  if (READ_TOOLS.has(name)) return ''
  if (value !== undefined && value !== null && typeof value === 'object' && value.ok === false) {
    const why = typeof value.error === 'string' && value.error !== ''
      ? value.error
      : typeof value.reason === 'string' ? value.reason : '未知原因'
    return `调用 ${toolLabel(name)} 失败：${clip(why, 60)}`
  }
  const arg = args !== null && typeof args === 'object' ? args : {}
  const ref = refOf(value?.todo)
  switch (name) {
    case 'global_todo_add': {
      const title = titleFrom(value?.todo, arg.title)
      return title === '' ? '新增 1 条待办' : `新增${ref}「${title}」`
    }
    case 'global_todo_capture': {
      const count = Number.isFinite(value?.count) ? value.count : Array.isArray(arg.items) ? arg.items.length : 0
      const skipped = Array.isArray(value?.skipped) ? value.skipped.length : 0
      return `批量登记 ${count} 条${skipped > 0 ? `，跳过 ${skipped} 条` : ''}`
    }
    case 'global_todo_update': {
      const changed = changedFields(arg)
      return `修改了${ref}${changed.length > 0 ? `：${changed.join('、')}` : ''}`
    }
    case 'global_todo_link': {
      const added = Array.isArray(arg.add) ? arg.add.length : 0
      const removed = Array.isArray(arg.remove) ? arg.remove.length : 0
      if (added > 0 && removed > 0) return `给${ref}换了附件（挂 ${added}、摘 ${removed}）`
      if (added > 0) return `给${ref}挂了 ${added} 个附件`
      if (removed > 0) return `从${ref}摘掉 ${removed} 个附件`
      return `调整了${ref}的附件`
    }
    case 'global_todo_note':
      return `给${ref}记了进展`
    case 'global_todo_done': {
      const status = typeof arg.status === 'string' && arg.status !== '' ? arg.status : 'done'
      if (status === 'done') return `完成${ref}`
      return `把${ref}标成 ${STATUS_LABELS[status] ?? status}`
    }
    case 'global_todo_reopen':
      return `把${ref}标回未完成`
    case 'global_todo_remove':
      return `删除${ref}「${titleFrom(undefined, value?.title)}」`
    default:
      return `调用了 ${toolLabel(name)}`
  }
}

/**
 * The message inside a session event, wherever that event keeps it.
 *
 * The two shapes are asymmetric in the Host's log (verified on 0.2.1):
 * `assistant/message` nests the message under `data.message`, `user/message`
 * carries the message **as** `data`. Reading one shape for both silently drops
 * every line of one kind — which is exactly how a rebuilt transcript lost the
 * person's half of the conversation.
 *
 * @param {unknown} data
 */
function messageOf(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.message !== undefined) return data.message
  if (Array.isArray(data.content)) return data
  return undefined
}

/** A notice carries `PREAMBLE\n\n<the line>`; the transcript shows only the line. */
function stripPreamble(text) {
  const body = typeof text === 'string' ? text : ''
  return body.startsWith(PREAMBLE) ? body.slice(PREAMBLE.length).trim() : body.trim()
}

/**
 * Rebuild a transcript from a session log. Order is the log's own; `seq` is used
 * to sort only when every row carries one, because a rebuilt room that reordered
 * itself would be worse than one that kept the file's order.
 *
 * Tool traces rebuilt here are coarser than live ones: the log's tool events do
 * not reliably carry the call's result, so the line says what was asked rather
 * than what came back. That asymmetry is deliberate — a live trace is exact, a
 * rebuilt one is honest about being rebuilt.
 *
 * @param {unknown} events
 * @param {{ limit?: number, now?: () => number }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function chatTranscriptFromEvents(events, options) {
  const limit = Math.max(1, Math.floor(Number(options?.limit)) || MAX_TRANSCRIPT)
  const now = typeof options?.now === 'function' ? options.now : Date.now
  const rows = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    const when = Number.isFinite(event.time) ? event.time : now()
    const seq = Number.isFinite(event.seq) ? event.seq : undefined
    if (event.type === 'user/message') {
      // Only our own notices belong here; a person never types into this session.
      if (event.data?.source?.kind !== CHAT_NOTICE_SOURCE) continue
      const text = stripPreamble(messageText(messageOf(event.data)))
      if (text === '') continue
      rows.push({ kind: 'user', at: when, seq, text })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = messageText(messageOf(event.data))
      if (text === '') continue
      rows.push({ kind: 'assistant', at: when, seq, text })
      continue
    }
    if (event.type === 'tool/call') {
      const name = typeof event.data?.name === 'string' ? event.data.name : ''
      if (!name.startsWith('global_todo_')) continue
      const line = summarizeToolCall(name, event.data?.args, undefined)
      if (line === '') continue
      rows.push({ kind: 'tool', at: when, seq, tool: shortToolName(name), text: line })
      continue
    }
    if (event.type === 'turn/end' && event.data?.reason !== undefined && event.data?.reason?.kind !== 'completed') {
      rows.push({ kind: 'note', at: when, seq, text: '这一轮没有正常结束（被打断或出错）。' })
    }
  }
  if (rows.length > 1 && rows.every((row) => row.seq !== undefined)) {
    rows.sort((left, right) => left.seq - right.seq)
  }
  return rows.slice(-limit).map(({ seq, ...entry }) => entry)
}

/**
 * @param {object} options
 * @param {object} options.ctx - the plugin context; services are read from its root
 * @param {object} [options.logger]
 * @param {{ get?: () => Record<string, unknown> }} [options.settings]
 * @param {string} options.file - the sidecar holding the butler's session id
 * @param {() => number} [options.now]
 */
export function createChat(options) {
  const ctx = options.ctx
  const logger = options.logger
  const settings = options.settings
  const sidecarFile = options.file
  const now = typeof options.now === 'function' ? options.now : Date.now

  /** The butler's session id; '' until the first line is sent. */
  let id = ''
  /** In-memory transcript ring. */
  const transcript = []
  /** True while a send is resolving (spawn/resume/followup). */
  let busy = false
  /** True between the session's turn/start and turn/end. */
  let turnActive = false
  /** True once the session/event subscription is live; the local user-echo covers its absence. */
  let watching = false
  /**
   * True while the session in `id` has never heard from us — the next line has to
   * carry the preamble. A transcript-based test gets this wrong exactly where it
   * matters: a replaced session with a transcript full of the *old* conversation's
   * lines would start the new session with no role at all.
   */
  let armed = true
  /** Sidecar writes are chained: a reset right after a send must not land first. */
  let persistChain = Promise.resolve()

  const log = (level, message, error) => {
    const sink = logger?.[level]
    if (typeof sink === 'function') sink.call(logger, `dsh-global-todo: ${message}`, error ?? '')
  }

  /** @returns {object} the root context; the plugin's own fiber is not enough */
  function rootCtx() {
    return ctx?.root ?? ctx
  }

  /** @returns {object | undefined} */
  function agents() {
    try {
      const service = rootCtx()?.get?.('agents')
      return service === undefined || service === null ? undefined : service
    } catch {
      return undefined
    }
  }

  /** A live agent for the butler session, or undefined. Never throws. */
  function liveAgent() {
    const store = agents()
    if (store === undefined || id === '' || typeof store.get !== 'function') return undefined
    try {
      const agent = store.get(id)
      return agent === undefined || agent === null ? undefined : agent
    } catch {
      return undefined
    }
  }

  /**
   * Where the butler session lives. The butler edits todos through the tools, so
   * the directory only matters as where a stray file tool would land — never the
   * store's own directory, where a hand-edit would bypass the write lock.
   */
  function chatDir() {
    const dir = settings?.get?.().chatDir
    if (typeof dir === 'string' && dir !== '') return dir
    const home = homedir()
    return typeof home === 'string' && home !== '' ? home : '.'
  }

  function push(entry) {
    transcript.push({ at: now(), ...entry })
    if (transcript.length > MAX_TRANSCRIPT) transcript.splice(0, transcript.length - MAX_TRANSCRIPT)
  }

  /** Best-effort: losing this file costs a new session, never a write. */
  function persist() {
    persistChain = persistChain
      .then(() => writeFile(sidecarFile, `${JSON.stringify({ id, at: now() })}\n`, 'utf8'))
      .catch(() => {})
  }

  /**
   * Create the butler session. The preset is this plugin's own — an empty plugin
   * list — because the Host's `minimal` turned out to carry a shell: everything
   * the butler needs is the todo tools, which the Host registers globally, and a
   * shell in the hands of "the thing that edits my list" is exactly the blast
   * radius this feature must not have. If the preset cannot be registered the
   * session is created without one (documented degraded), never with a
   * heavier preset: the fallback chain ends at "no preset", not at "more tools".
   */
  async function spawn(store) {
    const meta = { cwd: chatDir() }
    let setup
    const presets = rootCtx()?.get?.('agentPresets')
    if (presets !== undefined && presets !== null && typeof presets.register === 'function') {
      try {
        presets.register({ id: BUTLER_PRESET, name: '全局待办管家', plugins: [] })
      } catch {
        /* already registered by an earlier spawn, or refused: resolve decides */
      }
      try {
        const resolved = await presets.resolve(BUTLER_PRESET)
        if (resolved?.id !== undefined) {
          const presetId = resolved.id
          meta.agentPreset = presetId
          setup = async (agentCtx) => {
            await presets.mount(agentCtx, presetId)
          }
        }
      } catch (error) {
        log('warn', `解析管家 preset 失败，将不带 preset 创建：${asTodoError(error).message}`)
      }
    }
    const sessionId = `session-${randomUUID()}`
    let handle
    try {
      handle = await store.create({
        sessionId,
        meta,
        agentOptions: defaultModelSelection(rootCtx()),
        ...(setup === undefined ? {} : { setup }),
      })
    } catch (error) {
      throw new TodoError('dispatch-failed', `新建管家会话失败：${asTodoError(error).message}`)
    }
    id = sessionId
    armed = true
    persist()
    return handle?.agent
  }

  /**
   * A live agent, resuming the persisted session when the Host no longer holds
   * it. A session that cannot come back is replaced — visibly, as a note, so the
   * person knows the butler lost its thread rather than wondering.
   */
  async function liveOrResume(store) {
    const existing = liveAgent()
    if (existing !== undefined) return existing
    if (id !== '' && typeof store.resume === 'function') {
      try {
        const handle = await store.resume({ resumeSessionId: id, agentOptions: defaultModelSelection(rootCtx()) })
        if (handle?.agent !== undefined && handle.agent !== null) return handle.agent
      } catch (error) {
        log('warn', `管家会话无法恢复，将新开一个：${asTodoError(error).message}`)
      }
    }
    if (id !== '') push({ kind: 'note', text: '原会话已不可用，已新开一个会话继续。' })
    return spawn(store)
  }

  /** The whole chat state for GET /chat. Never throws. */
  function stateImpl() {
    const store = agents()
    const live = liveAgent()
    const running = busy || turnActive || live?.status === 'running'
    return {
      sessionId: id,
      alive: live !== undefined,
      running,
      canSend: store !== undefined && !running,
      watching,
      messages: transcript.map((entry) => ({ ...entry })),
    }
  }

  /**
   * Rebuild the transcript from the session log after a Host restart. Silent
   * when the Host has no query service: an empty room with a working session
   * beats a chat that refuses to start.
   */
  async function backfillImpl() {
    if (id === '' || transcript.length > 0) return
    let query
    try {
      query = rootCtx()?.get?.('sessionQuery')
    } catch {
      return
    }
    if (query === undefined || query === null || typeof query.readSession !== 'function') return
    let events
    try {
      const snapshot = await query.readSession(id)
      events = Array.isArray(snapshot?.events) ? snapshot.events : []
    } catch (error) {
      log('warn', `无法回读管家会话历史：${asTodoError(error).message}`)
      return
    }
    const rebuilt = chatTranscriptFromEvents(events, { limit: MAX_TRANSCRIPT, now })
    for (const entry of rebuilt) push(entry)
    // A session whose history the Host still remembers does not need the preamble
    // again; one whose transcript could not be rebuilt does.
    armed = !rebuilt.some((entry) => entry.kind === 'user')
    const last = rebuilt[rebuilt.length - 1]
    if (last?.kind === 'user') {
      push({ kind: 'note', text: '上一条还没有回复（宿主重启或会话被中断）。' })
    }
  }

  // The sidecar is read once, here rather than in an effect, because the backfill
  // depends on it: load the id, then rebuild what the Host still remembers.
  void readFile(sidecarFile, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text)
      if (typeof parsed?.id === 'string' && parsed.id !== '' && id === '') {
        id = parsed.id
        void backfillImpl()
      }
    })
    .catch(() => {
      /* absent or unreadable: the first line creates the session */
    })

  return {
    /** @returns {string} */
    sessionId() {
      return id
    },

    /** @returns {boolean} */
    watching() {
      return watching
    },

    /**
     * The whole chat state for GET /chat. Never throws: a panel that cannot ask
     * "what is the butler doing" has no fallback.
     */
    state: stateImpl,

    /**
     * Send one line. Rejects with `chat-busy` while the butler is working — the
     * caller shows the message and the person sends the same line a moment later.
     *
     * @param {unknown} text
     * @returns {Promise<{ sent: boolean, sessionId: string, fresh: boolean }>}
     */
    async send(text) {
      if (typeof text !== 'string') throw new TodoError('invalid-body', 'text 必须是字符串')
      const line = text.trim()
      if (line === '') throw new TodoError('invalid-body', '内容不能为空')
      if (line.length > MAX_CHAT_TEXT) throw new TodoError('invalid-body', `内容太长（最多 ${MAX_CHAT_TEXT} 字，收到 ${line.length}）`)
      const store = agents()
      if (store === undefined) throw new TodoError('agents-unavailable', '这个宿主没有 agents 服务，管家无法工作')
      if (busy || turnActive || liveAgent()?.status === 'running') {
        throw new TodoError('chat-busy', '管家还在处理上一条，等它说完再发')
      }
      busy = true
      try {
        const agent = await liveOrResume(store)
        if (agent === undefined || agent === null) {
          throw new TodoError('dispatch-failed', '管家会话没有返回可用的 agent')
        }
        if (typeof agent.followup !== 'function') {
          throw new TodoError('dispatch-failed', '管家会话不接受新的消息（followup 不可用）')
        }
        // The preamble rides the first line of a session, and the first line after
        // a transcript the plugin no longer has — the butler's role has to survive
        // a restart even where its visible history did not.
        const first = armed
        const prompt = first ? `${PREAMBLE}\n\n${line}` : line
        agent.followup(noticeMessage(prompt, CHAT_SUMMARY))
        armed = false
        // The person's line enters the transcript here and only here: the live
        // event feed broadcasts the butler's turns but not the notices this plugin
        // itself injects (verified on 0.2.1: assistant/message arrives,
        // user/message never does), so an event-driven echo would silently never
        // come. One writer for user entries also means no dedupe to get wrong.
        push({ kind: 'user', text: line })
        return { sent: true, sessionId: id, fresh: first }
      } finally {
        busy = false
      }
    },

    /**
     * Forget the session and start over on the next line. The old session is not
     * disposed: the application owns it, and it stays in the sidebar as the
     * conversation it was.
     */
    reset() {
      id = ''
      transcript.length = 0
      turnActive = false
      busy = false
      armed = true
      persist()
      return stateImpl()
    },

    /**
     * Record a tool call the butler made. Called from the tools wrapper with the
     * calling session's id, so todos the person edits elsewhere never land here.
     *
     * @param {{ name: string, args?: unknown, origin?: { sessionId?: string }, value?: unknown }} call
     */
    recordTool(call) {
      try {
        const sessionId = call?.origin?.sessionId
        if (id === '' || typeof sessionId !== 'string' || sessionId !== id) return
        const line = summarizeToolCall(call.name, call.args, call.value)
        if (line === '') return
        push({ kind: 'tool', tool: shortToolName(call.name), text: line, ok: call?.value?.ok !== false })
      } catch {
        /* tracing must never cost a tool call */
      }
    },

    /**
     * Feed one session event. Arg order follows the Host's session/event contract
     * sniffing already used elsewhere in this plugin. User entries never come
     * from here — see `send` for why the local copy is the only copy.
     *
     * @param {object | undefined} session
     * @param {object | undefined} event
     */
    handleEvent(session, event) {
      if (id === '' || typeof session?.id !== 'string' || session.id !== id) return
      try {
        if (event?.type === 'assistant/message') {
          const text = messageText(messageOf(event.data))
          if (text !== '') push({ kind: 'assistant', text })
          return
        }
        if (event?.type === 'turn/start') {
          turnActive = true
          return
        }
        if (event?.type === 'turn/end') {
          turnActive = false
          if (event.data?.reason !== undefined && event.data?.reason?.kind !== 'completed') {
            push({ kind: 'note', text: '这一轮没有正常结束（被打断或出错），清单可能没有改完。' })
          }
        }
      } catch {
        /* a malformed event must not break the feed */
      }
    },

    /**
     * Rebuild the transcript from the session log after a Host restart. Exposed
     * for the wiring effect and for tests; the sidecar load above calls it once
     * on its own.
     */
    backfill: backfillImpl,

    /** Mark the event feed live; exposed for the wiring effect and /health. */
    setWatching(value) {
      watching = value === true
    },
  }
}
