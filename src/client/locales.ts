/**
 * Copy for Raven's settings card.
 *
 * Spelled here rather than pulled from the Host schema descriptions. Those
 * descriptions are written for an operator reading YAML — they carry no title,
 * no order, no group, and no translation — while a form row needs a short label
 * a reader can scan and a hint that fits under a control.
 *
 * Both dictionaries carry the same key set on purpose: the Harness locale
 * registry requires every shipped locale at registration, so a key present in
 * one and absent from the other is a registration failure rather than a silent
 * fallback.
 * @module
 */

/**
 * The dictionary namespace owning this card's copy. It is the join key the
 * render machinery resolves the `t` seat through, so it must equal the
 * namespace declared in `slot-contract.ts`.
 */
export const RAVEN_LOCALE_NS = 'settings.raven-research'

/** Dictionary keys this card resolves. */export type RavenCardKey =
  | 'title' | 'description'
  | 'expand' | 'collapse' | 'unsaved' | 'readOnly' | 'memory' | 'unavailable' | 'loading'
  | 'group.evidence' | 'group.discovery' | 'group.prose' | 'group.draft' | 'group.other'
  | 'guidance' | 'guidanceHint'
  | 'sourceVerification' | 'sourceVerificationHint'
  | 'sourceNetworkPolicy' | 'sourceNetworkPolicyHint'
  | 'sourceCheckTimeoutMs' | 'sourceCheckTimeoutMsHint'
  | 'sourceDiscovery' | 'sourceDiscoveryHint'
  | 'searchMaxQueries' | 'searchMaxQueriesHint'
  | 'searchMaxResults' | 'searchMaxResultsHint'
  | 'searchTimeoutMs' | 'searchTimeoutMsHint'
  | 'proseLayout' | 'proseLayoutHint'
  | 'proseFormat' | 'proseFormatHint'
  | 'draftRoutes' | 'draftRoutesHint'
  | 'draftMaxTokens' | 'draftMaxTokensHint'
  | 'draftTimeoutMs' | 'draftTimeoutMsHint'
  | 'choice.auto' | 'choice.off'
  | 'choice.remote' | 'choice.structural-only'
  | 'choice.public-only' | 'choice.unrestricted'
  | 'choice.seam' | 'choice.disabled'
  | 'choice.sentence-per-line' | 'choice.as-written'
  | 'choice.markdown' | 'choice.plain'
  | 'overridden' | 'reset'
  | 'invalidRoutes'
  | 'save' | 'saving' | 'discard' | 'saveFailed'

/** English copy. */
export const en: Record<RavenCardKey, string> = {
  title: 'Raven research',
  description: 'Progressive, source-grounded research, writing, and learning.',
  expand: 'Expand',
  collapse: 'Collapse',
  unsaved: 'Unsaved',
  readOnly: 'This configuration document is read-only, so these controls cannot be saved.',
  memory: 'This connection keeps preferences process-local, so changes cannot be saved.',
  unavailable: 'These settings are not served to this client.',
  loading: 'Loading…',
  'group.evidence': 'Evidence',
  'group.discovery': 'Discovery',
  'group.prose': 'Artifact prose',
  'group.draft': 'Draft Variants',
  'group.other': 'Other',
  guidance: 'Contextual guidance',
  guidanceHint:
    'Auto lets the main agent mention one useful Raven option only when relevant, without tutorials, repetition, or approval gates. Off suppresses these optional hints; Task behavior is unchanged.',
  sourceVerification: 'Source verification',
  sourceVerificationHint:
    'Whether recorded Sources are re-fetched to confirm their excerpts. Structural only makes every Source '
    + 'unverifiable, so a Checkpoint carrying Sources is refused rather than published unchecked.',
  sourceNetworkPolicy: 'Source network policy',
  sourceNetworkPolicyHint:
    'Public only refuses local/private destinations before fetching. It reduces SSRF exposure but cannot stop DNS '
    + 'rebinding inside the provider. Unrestricted is only for an already confined or intentionally internal provider.',
  sourceCheckTimeoutMs: 'Source check deadline',
  sourceCheckTimeoutMsHint:
    'Milliseconds allowed for one remote Source check; 0 means no deadline. An exceeded deadline reports that '
    + 'one Source as unverifiable instead of holding the Checkpoint open.',
  sourceDiscovery: 'Lead discovery',
  sourceDiscoveryHint:
    'Whether raven_task action=discover may run queries through the Harness web search seam. Disabled reports '
    + 'discovery as unavailable and records a Limitation; it never makes the agent believe it searched.',
  searchMaxQueries: 'Queries per discovery batch',
  searchMaxQueriesHint: 'Upper bound on queries accepted by one discover call; 0 means the built-in bound.',
  searchMaxResults: 'Candidates per query',
  searchMaxResultsHint: 'Upper bound on candidates requested per query; 0 means the built-in bound.',
  searchTimeoutMs: 'Discovery query deadline',
  searchTimeoutMsHint:
    'Milliseconds allowed for one discovery query; 0 means no deadline. A query that exceeds it is recorded as '
    + 'a failed query; its siblings still return their Leads.',
  proseLayout: 'Prose layout',
  proseLayoutHint:
    'How every stored Artifact is laid out. Sentence per line makes a LINE the smallest edit unit, so a revision '
    + 'diffs as the sentences that changed. Markdown structure is never reflowed.',
  proseFormat: 'Artifact format',
  proseFormatHint:
    'Markdown is the default final output format and is what makes the layout structure-aware. Plain treats every '
    + 'line as prose.',
  draftRoutes: 'Draft Variant routes',
  draftRoutesHint:
    'One provider/model per line. This list is the whole universe: the agent may select a subset and nothing else. '
    + 'Empty disables Draft Variants and says so.',
  draftMaxTokens: 'Draft length bound',
  draftMaxTokensHint: 'Model output tokens allowed for one Draft Variant; 0 means the built-in bound.',
  draftTimeoutMs: 'Draft deadline',
  draftTimeoutMsHint:
    'Milliseconds allowed for one Draft Variant; 0 means no deadline. A route that exceeds it produces no variant; '
    + 'its siblings still return theirs.',
  'choice.auto': 'Auto',
  'choice.off': 'Off',
  'choice.remote': 'Re-fetch',
  'choice.structural-only': 'Structural only',
  'choice.public-only': 'Public network only',
  'choice.unrestricted': 'Unrestricted',
  'choice.seam': 'Search seam',
  'choice.disabled': 'Disabled',
  'choice.sentence-per-line': 'Sentence per line',
  'choice.as-written': 'As written',
  'choice.markdown': 'Markdown',
  'choice.plain': 'Plain',
  overridden: 'Overridden',
  reset: 'Reset',
  invalidRoutes: 'Write one provider/model route per line; the engine skips any other line.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'The last save did not land. Retry, or discard to reload what the Host holds.',
}

/** Simplified Chinese copy. */
export const zh: Record<RavenCardKey, string> = {
  title: 'Raven 深度研究',
  description: '渐进式、以证据为准的研究、写作与学习。',
  expand: '展开',
  collapse: '收起',
  unsaved: '未保存',
  readOnly: '当前配置文档为只读，这些设置无法保存。',
  memory: '当前连接的偏好仅存于进程内存，修改无法保存。',
  unavailable: '该命名空间未向此客户端提供。',
  loading: '加载中…',
  'group.evidence': '证据核验',
  'group.discovery': '线索发现',
  'group.prose': 'Artifact 排版',
  'group.draft': 'Draft Variant',
  'group.other': '其它',
  guidance: '情境提示',
  guidanceHint: '自动模式仅在相关时让主 Agent 简短提示一项 Raven 能力，不会变成教程、重复提示或审批流程。关闭后不再提供此类可选提示，Task 行为不变。',
  sourceVerification: 'Source 校验方式',
  sourceVerificationHint:
    '是否重新抓取已登记的 Source 以核对其原文摘录。选择「仅结构校验」后任何 Source 都无法被确认，'
    + '携带 Source 的 Checkpoint 会被拒绝，而不是未经核对就发布。',
  sourceNetworkPolicy: 'Source 网络策略',
  sourceNetworkPolicyHint:
    '「仅公共网络」会在抓取前拒绝本机或私有地址，可降低 SSRF 暴露，但无法阻止 provider 内部的 DNS rebinding。'
    + '仅当 fetch provider 已被网络隔离或明确用于可信内网时，才使用「不限制」。',
  sourceCheckTimeoutMs: 'Source 校验超时',
  sourceCheckTimeoutMsHint:
    '单次远程 Source 校验的毫秒上限，0 表示不限。超时会把该 Source 记为无法核验，而不是让 Checkpoint 一直挂起。',
  sourceDiscovery: 'Lead 发现',
  sourceDiscoveryHint:
    'raven_task action=discover 是否可以通过 Harness 的网页搜索接缝发起查询。选择「禁用」会将发现能力报告为不可用'
    + '并记录一条 Limitation，绝不会让 agent 误以为自己搜索过。',
  searchMaxQueries: '单批发现查询数上限',
  searchMaxQueriesHint: '单次 discover 调用可接受的查询条数上限，0 表示使用内置上限。',
  searchMaxResults: '单条查询候选数上限',
  searchMaxResultsHint: '每条查询请求的候选条目数上限，0 表示使用内置上限。',
  searchTimeoutMs: '发现查询超时',
  searchTimeoutMsHint:
    '单条发现查询的毫秒上限，0 表示不限。超时的查询会被记为失败查询，同批其它查询仍会返回各自的 Lead。',
  proseLayout: '正文排版',
  proseLayoutHint:
    '所有存储的 Artifact 的排版方式。「一句一行」让「行」成为最小编辑单元，改稿的 diff 就是真正改动的那几句。'
    + 'Markdown 结构永不重排。',
  proseFormat: 'Artifact 格式',
  proseFormatHint: 'Markdown 是默认的最终输出格式，也是排版能识别结构的前提。「纯文本」把每一行都当作正文处理。',
  draftRoutes: 'Draft Variant 路由',
  draftRoutesHint:
    '每行一个 provider/model。这份清单即全集：agent 只能从中挑选子集，不能另选。留空则停用 Draft Variant 并如实说明。',
  draftMaxTokens: 'Draft 长度上限',
  draftMaxTokensHint: '单个 Draft Variant 的模型输出 token 上限，0 表示使用内置上限。',
  draftTimeoutMs: 'Draft 超时',
  draftTimeoutMsHint:
    '单个 Draft Variant 的毫秒上限，0 表示不限。超时的路由不产出变体，同轮其它路由仍会返回各自的变体。',
  'choice.auto': '自动',
  'choice.off': '关闭',
  'choice.remote': '重新抓取核验',
  'choice.structural-only': '仅结构校验',
  'choice.public-only': '仅公共网络',
  'choice.unrestricted': '不限制',
  'choice.seam': '走搜索接缝',
  'choice.disabled': '禁用',
  'choice.sentence-per-line': '一句一行',
  'choice.as-written': '保持原样',
  'choice.markdown': 'Markdown',
  'choice.plain': '纯文本',
  overridden: '已覆盖',
  reset: '重置',
  invalidRoutes: '每行填写一个 provider/model 路由；其它写法会被引擎直接跳过。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  saveFailed: '上次保存未生效。请重试，或放弃以重新读取 Host 的当前值。',
}
