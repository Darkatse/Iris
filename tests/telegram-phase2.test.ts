/**
 * Telegram Phase 2 测试。
 *
 * 验证消息构建器、命令解析器的升级功能。
 */

import { describe, expect, it } from 'vitest';
import { TelegramMessageBuilder, formatTelegramToolLine } from '../extensions/telegram/src/message-builder';
import { TelegramCommandRouter, TELEGRAM_BOT_COMMANDS } from '../extensions/telegram/src/commands';
import { buildTelegramStatusSnapshot, formatTelegramStatusMarkdown, formatTelegramStatusText } from '../extensions/telegram/src/status';

describe('Telegram Phase 2: message builder', () => {
  const builder = new TelegramMessageBuilder();

  it('构建 thinking 占位文本', () => {
    expect(builder.buildThinkingText()).toContain('思考');
  });

  it('构建错误文本', () => {
    expect(builder.buildErrorText('timeout')).toContain('❌');
    expect(builder.buildErrorText('timeout')).toContain('timeout');
  });

  it('构建中止文本（有 buffer）', () => {
    expect(builder.buildAbortedText('已输出部分')).toContain('已输出部分');
    expect(builder.buildAbortedText('已输出部分')).toContain('已中止');
  });

  it('构建中止文本（无 buffer）', () => {
    expect(builder.buildAbortedText('')).toContain('已中止');
  });

  it('格式化工具状态行', () => {
    expect(formatTelegramToolLine({ toolName: 'read_file', status: 'executing' })).toContain('🔧');
    expect(formatTelegramToolLine({ toolName: 'read_file', status: 'executing' })).toContain('read_file');
    expect(formatTelegramToolLine({ toolName: 'write_file', status: 'success' })).toContain('✅');
    expect(formatTelegramToolLine({ toolName: 'shell', status: 'error' })).toContain('❌');
  });
});

describe('Telegram Phase 2: command router', () => {
  const router = new TelegramCommandRouter();

  it('解析基础命令', () => {
    expect(router.parse('/new')).toEqual({ name: 'new', args: '' });
    expect(router.parse('/model gpt-4')).toEqual({ name: 'model', args: 'gpt-4' });
  });

  it('去除 @botname 后缀', () => {
    expect(router.parse('/new@iris_bot')).toEqual({ name: 'new', args: '' });
    expect(router.parse('/model@iris_bot gpt-4')).toEqual({ name: 'model', args: 'gpt-4' });
  });

  it('非命令返回 null', () => {
    expect(router.parse('hello')).toBeNull();
    expect(router.parse('')).toBeNull();
  });

  it('帮助文本包含所有命令', () => {
    const help = router.buildHelpText();
    for (const cmd of TELEGRAM_BOT_COMMANDS) {
      expect(help).toContain(`/${cmd.command}`);
    }
    expect(help).toContain('/status');
  });
});

describe('Telegram /status', () => {
  it('从 Backend 公共读接口构建当前状态', async () => {
    const model = {
      modelName: 'gpt_main',
      modelId: 'gpt-5.4',
      provider: 'openai-responses',
      contextWindow: 128000,
      current: true,
    };
    const backend = {
      listModels: () => [model],
      getCurrentModelInfo: () => model,
      getHistory: async () => [
        { role: 'model', parts: [], usageMetadata: { totalTokenCount: 1000 } },
        { role: 'user', parts: [{ text: '继续' }] },
        {
          role: 'model',
          parts: [],
          usageMetadata: {
            promptTokenCount: 900,
            cachedContentTokenCount: 100,
            candidatesTokenCount: 300,
            totalTokenCount: 1200,
          },
        },
      ],
      isStreamEnabled: () => true,
      getToolNames: () => ['read_file', 'write_file', 'shell'],
      getDisabledTools: () => ['write_file'],
      listModes: () => [{ name: 'code', current: true }],
      getRunningAgentTasks: () => [{ taskId: 'task-1' }],
    };

    const snapshot = await buildTelegramStatusSnapshot({
      backend: backend as any,
      sessionId: 'telegram-dm-1',
      agentName: 'master',
      busy: true,
      pendingMessages: 2,
    });

    expect(snapshot.usage?.totalTokenCount).toBe(1200);
    expect(formatTelegramStatusText(snapshot)).toContain('上下文: 1,200 / 128,000 (1%)');
    expect(formatTelegramStatusText(snapshot)).toContain('工具: 启用 2 个，禁用 1 个');
    expect(formatTelegramStatusMarkdown(snapshot)).toContain('| 上下文 | `1,200 / 128,000 (1%)` |');
    expect(formatTelegramStatusMarkdown(snapshot)).toContain('| 后台任务 | `1` |');
  });
});
