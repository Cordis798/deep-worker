export interface LayoutRect {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MobileChatCheck {
  name: string;
  passed: boolean;
  detail: string;
}

function overlaps(left: LayoutRect, right: LayoutRect) {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

export function evaluateMobileChatLayout(viewportWidth: number, elements: LayoutRect[]): MobileChatCheck[] {
  const checks: MobileChatCheck[] = [
    {
      name: '移动端视口',
      passed: viewportWidth <= 640,
      detail: viewportWidth <= 640 ? '视口宽度处于移动端范围' : `当前视口宽度为 ${viewportWidth}px`,
    },
  ];
  const composer = elements.find((element) => element.name === 'composer');
  const input = elements.find((element) => element.name === 'input');
  const send = elements.find((element) => element.name === 'send');
  checks.push({ name: '消息输入区存在', passed: !!composer && !!input && !!send, detail: composer && input && send ? '输入框、发送按钮和容器均可定位' : '缺少聊天输入区元素' });
  if (composer && input && send) {
    checks.push({ name: '输入区不溢出', passed: input.left >= composer.left && input.right <= composer.right && send.left >= composer.left && send.right <= composer.right, detail: '控件边界位于输入容器内' });
    checks.push({ name: '控件不重叠', passed: !overlaps(input, send), detail: '输入框与发送按钮保持可点击间距' });
  }
  return checks;
}

export function runMobileChatHarness(documentRoot: Document = document): MobileChatCheck[] {
  const names = ['composer', 'input', 'send'] as const;
  const elements = names.flatMap((name) => {
    const element = documentRoot.querySelector<HTMLElement>(`[data-mobile-chat="${name}"]`);
    if (!element) return [];
    const rect = element.getBoundingClientRect();
    return [{ name, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }];
  });
  return evaluateMobileChatLayout(window.innerWidth, elements);
}
