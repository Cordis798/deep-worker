import { describe, expect, it } from 'vitest';
import { evaluateMobileChatLayout } from './mobile-chat-harness.js';

describe('移动端聊天布局检查器', () => {
  it('验证输入区和发送按钮在窄屏内保持可用', () => {
    const checks = evaluateMobileChatLayout(390, [
      { name: 'composer', left: 12, top: 700, right: 378, bottom: 780 },
      { name: 'input', left: 22, top: 714, right: 300, bottom: 766 },
      { name: 'send', left: 308, top: 714, right: 368, bottom: 766 },
    ]);
    expect(checks.every((check) => check.passed)).toBe(true);
  });

  it('能发现控件重叠或超出输入容器', () => {
    const checks = evaluateMobileChatLayout(390, [
      { name: 'composer', left: 12, top: 700, right: 378, bottom: 780 },
      { name: 'input', left: 22, top: 714, right: 330, bottom: 766 },
      { name: 'send', left: 320, top: 714, right: 390, bottom: 766 },
    ]);
    expect(checks.find((check) => check.name === '输入区不溢出')?.passed).toBe(false);
    expect(checks.find((check) => check.name === '控件不重叠')?.passed).toBe(false);
  });
});
