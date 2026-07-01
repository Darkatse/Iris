import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlatform, createTelegramPlatform } from '../extensions/telegram/src/index.js';

class FakeBackend extends EventEmitter {
  activeSessionId?: string;
  cwd?: string;

  isStreamEnabled() { return false; }
  getActiveSessionId() { return this.activeSessionId; }
  getCwd() { return this.cwd; }
}

function createTarget() {
  return {
    sessionId: 'telegram-dm-123',
    chatId: 123,
    chatKey: 'dm:123',
    scope: 'dm' as const,
  };
}

function installMockClient(platform: TelegramPlatform) {
  const client = {
    sendText: vi.fn(async () => undefined),
    sendPhoto: vi.fn(async () => 11),
    sendVoice: vi.fn(async () => 22),
    sendAudio: vi.fn(async () => 33),
    sendDocument: vi.fn(async () => 44),
  };
  (platform as any).client = client;
  return client;
}

const flushAsyncListeners = () => new Promise((resolve) => setImmediate(resolve));

describe('telegram delivery attachment provider', () => {
  it('factory 注册 telegram_send_file 工具', async () => {
    const registerAll = vi.fn();
    const platform = await createTelegramPlatform({
      backend: new FakeBackend() as any,
      config: { platform: { telegram: { token: 'bot-token' } } },
      api: { tools: { registerAll } },
    } as any);

    expect(platform).toBeInstanceOf(TelegramPlatform);
    expect(registerAll).toHaveBeenCalledWith([
      expect.objectContaining({
        declaration: expect.objectContaining({ name: 'telegram_send_file' }),
      }),
    ]);
  });

  it('factory 在 api.tools 不存在时跳过工具注册', async () => {
    await expect(createTelegramPlatform({
      backend: new FakeBackend() as any,
      config: { platform: { telegram: { token: 'bot-token' } } },
      api: {},
    } as any)).resolves.toBeInstanceOf(TelegramPlatform);
  });

  it('注册 image/audio/file 能力并通过统一附件分派发送图片、语音、音频和文件', async () => {
    let provider: any;
    const registry = {
      registerProvider: vi.fn((p: any) => {
        provider = p;
        return { dispose() {} };
      }),
    };
    const api = { services: { get: vi.fn((id: string) => id === 'delivery.registry' ? registry : undefined) } } as any;
    const platform = new TelegramPlatform(new FakeBackend() as any, { token: 'bot-token' }, api);
    const client = installMockClient(platform);

    (platform as any).registerDeliveryProvider();

    expect(provider.capabilities).toMatchObject({ text: true, image: true, audio: true, file: true });

    await expect(provider.sendAttachment({
      target: { kind: 'chat', id: '123' },
      attachment: { type: 'image', mimeType: 'image/png', data: Buffer.from('png') },
      caption: '图片说明',
    })).resolves.toMatchObject({ ok: true, platform: 'telegram', messageId: '11' });

    await expect(provider.sendAttachment({
      target: { kind: 'chat', id: '123' },
      attachment: { type: 'voice', mimeType: 'audio/ogg', data: Buffer.from('ogg'), fileName: 'voice.ogg', caption: '内置说明' },
      caption: '外层说明',
    })).resolves.toMatchObject({ ok: true, platform: 'telegram', messageId: '22' });

    await expect(provider.sendAttachment({
      target: { kind: 'chat', id: '123' },
      attachment: { type: 'audio', mimeType: 'audio/mpeg', data: Buffer.from('mp3'), fileName: 'voice.mp3' },
    })).resolves.toMatchObject({ ok: true, platform: 'telegram', messageId: '33' });

    await expect(provider.sendAttachment({
      target: { kind: 'chat', id: '123' },
      attachment: { type: 'file', mimeType: 'text/plain', data: Buffer.from('txt'), fileName: 'note.txt' },
    })).resolves.toMatchObject({ ok: true, platform: 'telegram', messageId: '44' });

    expect(client.sendPhoto).toHaveBeenCalledWith(expect.objectContaining({ chatId: 123 }), expect.any(Buffer), '图片说明');
    expect(client.sendVoice).toHaveBeenCalledWith(expect.objectContaining({ chatId: 123 }), expect.any(Buffer), 'voice.ogg', '外层说明');
    expect(client.sendAudio).toHaveBeenCalledWith(expect.objectContaining({ chatId: 123 }), expect.any(Buffer), 'voice.mp3', undefined);
    expect(client.sendDocument).toHaveBeenCalledWith(expect.objectContaining({ chatId: 123 }), expect.any(Buffer), 'note.txt', undefined);
  });

  it('Backend attachments 事件会发送图片、音频和普通文件', async () => {
    const backend = new FakeBackend();
    const platform = new TelegramPlatform(backend as any, { token: 'bot-token' });
    const client = installMockClient(platform);
    const chatState = (platform as any).getChatState(createTarget());

    (platform as any).setupBackendListeners();
    backend.emit('attachments', chatState.sessionId, [
      { type: 'image', mimeType: 'image/png', data: Buffer.from('png') },
      { type: 'audio', mimeType: 'audio/mpeg', data: Buffer.from('mp3'), fileName: 'voice.mp3' },
      { type: 'file', mimeType: 'text/plain', data: Buffer.from('txt'), fileName: 'note.txt' },
    ]);
    await flushAsyncListeners();

    expect(client.sendPhoto).toHaveBeenCalledOnce();
    expect(client.sendAudio).toHaveBeenCalledOnce();
    expect(client.sendDocument).toHaveBeenCalledOnce();
  });

  it('telegram_send_file 从当前 Telegram 会话读取本地文件并发送', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'iris-telegram-'));
    const filePath = join(tmp, 'shot.png');
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4E, 0x47]));

    try {
      const backend = new FakeBackend();
      backend.cwd = tmp;
      const platform = new TelegramPlatform(backend as any, { token: 'bot-token' });
      const client = installMockClient(platform);
      const chatState = (platform as any).getChatState(createTarget());
      backend.activeSessionId = chatState.sessionId;

      const [tool] = platform.createTelegramTools();
      const result = await tool.handler({ file_path: 'shot.png', message: '截图' }, { sessionId: chatState.sessionId } as any);

      expect(result).toMatchObject({
        success: true,
        fileName: 'shot.png',
        fileSize: 4,
        messageId: '11',
      });
      expect(client.sendPhoto).toHaveBeenCalledWith(expect.objectContaining({ chatId: 123 }), expect.any(Buffer), '截图');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('telegram_send_file 在非 Telegram 会话中 fail-fast', async () => {
    const platform = new TelegramPlatform(new FakeBackend() as any, { token: 'bot-token' });
    const [tool] = platform.createTelegramTools();

    await expect(tool.handler({ file_path: '/tmp/missing.txt' }, {} as any))
      .rejects.toThrow('当前不在 Telegram 会话中');
  });
});
