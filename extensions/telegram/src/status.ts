/**
 * Telegram /status 状态快照与展示格式。
 *
 * 状态数据来自 Backend 已暴露的只读接口；Telegram 层只合并当前聊天的 busy/queue
 * 这类平台状态，并负责把快照渲染成普通文本或 Rich Message Markdown。
 */

import type { Content, IrisBackendLike, IrisModelInfoLike, UsageMetadata } from 'irises-extension-sdk';

/** /status 构建快照时需要的运行时上下文。 */
export interface TelegramStatusInput {
  backend: IrisBackendLike;
  sessionId: string;
  agentName?: string;
  busy: boolean;
  pendingMessages: number;
}

/** 只包含展示所需的只读数据，不持有 backend/client 等运行时对象。 */
export interface TelegramStatusSnapshot {
  agentName: string;
  sessionId: string;
  state: 'busy' | 'idle';
  pendingMessages: number;
  modeName: string;
  model: IrisModelInfoLike;
  usage?: UsageMetadata;
  streamEnabled: boolean;
  toolCount: number;
  disabledToolCount: number;
  runningTaskCount: number;
}

/**
 * 汇总当前会话状态。
 *
 * 模型信息是 /status 的核心字段，缺失通常表示宿主尚未初始化完成，因此直接 fail-fast。
 * 其他字段通过 IrisBackendLike 的可选读接口补充，保持平台 extension 对旧宿主的兼容。
 */
export async function buildTelegramStatusSnapshot(input: TelegramStatusInput): Promise<TelegramStatusSnapshot> {
  const models = input.backend.listModels();
  const model = input.backend.getCurrentModelInfo?.() ?? models.find((item) => item.current) ?? models[0];
  if (!model) throw new Error('当前模型信息不可用');

  const history = await input.backend.getHistory?.(input.sessionId) ?? [];
  const tools = input.backend.getToolNames?.() ?? [];
  const disabledTools = input.backend.getDisabledTools?.() ?? [];
  const currentMode = input.backend.listModes?.().find((mode) => mode.current)?.name ?? 'normal';

  return {
    agentName: input.agentName ?? 'master',
    sessionId: input.sessionId,
    state: input.busy ? 'busy' : 'idle',
    pendingMessages: input.pendingMessages,
    modeName: currentMode,
    model,
    usage: findLatestUsage(history),
    streamEnabled: input.backend.isStreamEnabled(),
    toolCount: tools.length,
    disabledToolCount: disabledTools.length,
    runningTaskCount: input.backend.getRunningAgentTasks?.(input.sessionId).length ?? 0,
  };
}

/** 普通文本输出，用于 plain 模式和 Rich Message 失败后的 fallback。 */
export function formatTelegramStatusText(status: TelegramStatusSnapshot): string {
  const lines = [
    '📊 当前状态',
    '',
    `智能体: ${status.agentName}`,
    `会话: ${status.sessionId}`,
    `状态: ${formatState(status.state)}`,
    `排队消息: ${formatNumber(status.pendingMessages)}`,
    `模式: ${status.modeName}`,
    `模型: ${status.model.modelName} → ${status.model.modelId}`,
    ...(status.model.provider ? [`提供商: ${status.model.provider}`] : []),
    `上下文: ${formatContextUsage(status)}`,
    `Token: ${formatTokenBreakdown(status.usage)}`,
    `流式输出: ${formatStream(status.streamEnabled)}`,
    `工具: ${formatToolCounts(status)}`,
    `后台任务: ${formatNumber(status.runningTaskCount)}`,
  ];
  return lines.join('\n');
}

/** Rich Message 输出。表格值统一包成 code cell，避免 sessionId/modelId 中的符号破坏 Markdown 表格。 */
export function formatTelegramStatusMarkdown(status: TelegramStatusSnapshot): string {
  const rows = [
    ['智能体', status.agentName],
    ['会话', status.sessionId],
    ['状态', formatState(status.state)],
    ['排队消息', formatNumber(status.pendingMessages)],
    ['模式', status.modeName],
    ['模型', `${status.model.modelName} → ${status.model.modelId}`],
    ...(status.model.provider ? [['提供商', status.model.provider]] : []),
    ['上下文', formatContextUsage(status)],
    ['Token', formatTokenBreakdown(status.usage)],
    ['流式输出', formatStream(status.streamEnabled)],
    ['工具', formatToolCounts(status)],
    ['后台任务', formatNumber(status.runningTaskCount)],
  ];

  return [
    '**📊 当前状态**',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    ...rows.map(([key, value]) => `| ${key} | ${codeCell(value)} |`),
  ].join('\n');
}

/** 使用最近一次模型返回的 usage 作为当前上下文用量；用户消息通常没有 usageMetadata。 */
function findLatestUsage(history: Content[]): UsageMetadata | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const usage = history[i]?.usageMetadata;
    if (usage?.totalTokenCount != null) return usage;
  }
  return undefined;
}

function formatContextUsage(status: TelegramStatusSnapshot): string {
  const total = status.usage?.totalTokenCount;
  const window = status.model.contextWindow;
  if (total == null) return window ? `- / ${formatNumber(window)}` : '-';
  if (!window) return formatNumber(total);
  return `${formatNumber(total)} / ${formatNumber(window)} (${Math.round(total / window * 100)}%)`;
}

function formatTokenBreakdown(usage?: UsageMetadata): string {
  if (!usage) return '-';
  const parts = [
    usage.promptTokenCount != null ? `输入 ${formatNumber(usage.promptTokenCount)}` : '',
    usage.cachedContentTokenCount != null ? `缓存 ${formatNumber(usage.cachedContentTokenCount)}` : '',
    usage.candidatesTokenCount != null ? `输出 ${formatNumber(usage.candidatesTokenCount)}` : '',
  ].filter(Boolean);
  return parts.join('，') || '-';
}

function formatState(state: TelegramStatusSnapshot['state']): string {
  return state === 'busy' ? '忙碌' : '空闲';
}

function formatStream(enabled: boolean): string {
  return enabled ? '开启' : '关闭';
}

function formatToolCounts(status: TelegramStatusSnapshot): string {
  const enabled = Math.max(0, status.toolCount - status.disabledToolCount);
  return `启用 ${formatNumber(enabled)} 个，禁用 ${formatNumber(status.disabledToolCount)} 个`;
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

/** Telegram Rich Message Markdown 表格中，值列既要保留等宽展示，也要转义表格分隔符。 */
function codeCell(value: string): string {
  return `\`${value.replace(/`/g, "'").replace(/\|/g, '\\|')}\``;
}
