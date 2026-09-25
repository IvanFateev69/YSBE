import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(ROOT, '.profile');
const TMP_DIR = path.join(ROOT, 'tmp');
const START_URL = 'https://education.yandex.ru/uchebnik/main';

fs.mkdirSync(TMP_DIR, { recursive: true });

let context = null;
let page = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function getPage() {
  if (page && !page.isClosed()) return page;
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  page = context.pages()[0] || (await context.newPage());
  if (page.url() === 'about:blank') {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded' });
  }
  context.on('close', () => {
    context = null;
    page = null;
  });
  return page;
}

async function firstVisible(p, selectors) {
  for (const sel of selectors) {
    const loc = p.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1500 })) return loc;
    } catch {}
  }
  return null;
}

const EDITOR_SELECTORS = [
  '.monaco-editor',
  '.CodeMirror',
  '[class*="code-editor"]',
  '[class*="editor"] textarea',
  'div[contenteditable="true"]',
];

const TASK_TEXT_SELECTORS = [
  '[class*="statement"]',
  '[class*="task-description"]',
  '[class*="task__text"]',
  '[class*="condition"]',
  '[class*="theory"]',
  'article',
  'main',
];

const RUN_BUTTON_TEXTS = ['Проверить', 'Запустить', 'Отправить', 'Run', 'Check', 'Submit'];
const NEXT_BUTTON_TEXTS = ['Далее', 'Следующая', 'Продолжить', 'Дальше', 'Next', 'Continue'];

function cleanText(t) {
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function detectType(p) {
  if (await firstVisible(p, EDITOR_SELECTORS)) return 'code';
  const radio = await p.locator('input[type="radio"], [role="radio"]').count();
  const checkbox = await p.locator('input[type="checkbox"], [role="checkbox"]').count();
  if (radio + checkbox > 0) return 'test';
  return 'theory';
}

async function clickButtonByText(p, texts) {
  for (const t of texts) {
    const btn = p
      .locator(`button:has-text("${t}"), [role="button"]:has-text("${t}")`)
      .first();
    try {
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click();
        return t;
      }
    } catch {}
  }
  return null;
}

const server = new McpServer({
  name: 'ysbe',
  version: '1.0.0',
});

server.tool(
  'status',
  'URL и заголовок текущей страницы браузера',
  {},
  async () => {
    const p = await getPage();
    return {
      content: [{ type: 'text', text: JSON.stringify({ url: p.url(), title: await p.title() }) }],
    };
  }
);

server.tool(
  'read_task',
  'Прочитать текущую карточку: тип (code/test/theory) и текст условия',
  {},
  async () => {
    const p = await getPage();
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    const type = await detectType(p);
    const block = await firstVisible(p, TASK_TEXT_SELECTORS);
    let text = block ? await block.innerText() : await p.locator('body').innerText();
    text = cleanText(text).slice(0, 4000);
    return {
      content: [{ type: 'text', text: JSON.stringify({ type, text }) }],
    };
  }
);

server.tool(
  'type_code',
  'Напечатать код в редакторе посимвольно, как человек с клавиатуры (не вставка!)',
  { code: z.string().describe('Код без комментариев') },
  async ({ code }) => {
    const p = await getPage();
    const editor = await firstVisible(p, EDITOR_SELECTORS);
    if (!editor) {
      return { content: [{ type: 'text', text: 'error: редактор не найден' }] };
    }
    await editor.click();
    await sleep(300);
    await p.keyboard.press('Control+a');
    await p.keyboard.press('Delete');
    await sleep(200);
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      await p.keyboard.press('Shift+Home');
      await sleep(rand(30, 70));
      for (const ch of lines[i]) {
        await p.keyboard.type(ch);
        await sleep(rand(30, 90));
      }
      if (i < lines.length - 1) {
        await p.keyboard.press('Enter');
        await sleep(rand(80, 220));
      }
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

server.tool(
  'run_code',
  'Нажать кнопку запуска/проверки решения',
  {},
  async () => {
    const p = await getPage();
    const clicked = await clickButtonByText(p, RUN_BUTTON_TEXTS);
    if (!clicked) {
      return { content: [{ type: 'text', text: 'error: кнопка проверки не найдена' }] };
    }
    await sleep(1500);
    return { content: [{ type: 'text', text: 'ok: ' + clicked }] };
  }
);

server.tool(
  'read_result',
  'Прочитать результат проверки: зачёт или текст ошибки',
  {},
  async () => {
    const p = await getPage();
    const loc = await firstVisible(p, [
      '[class*="success"]',
      '[class*="error"]:not([class*="boundary"])',
      '[class*="verdict"]',
      '[class*="result"]',
      '[class*="output"]',
      '[role="alert"]',
    ]);
    let text = loc ? await loc.innerText() : '';
    text = cleanText(text || 'результат не найден').slice(0, 2000);
    return { content: [{ type: 'text', text }] };
  }
);

server.tool(
  'answer',
  'Ответить на тест: выбрать вариант по тексту/номеру или ввести текст в поле',
  {
    option: z.string().optional().describe('Текст варианта ответа или его номер (1-based)'),
    text: z.string().optional().describe('Текст для поля ввода'),
  },
  async ({ option, text }) => {
    const p = await getPage();
    if (text !== undefined) {
      const input = await firstVisible(p, [
        'input[type="text"]',
        'input:not([type])',
        'textarea',
      ]);
      if (!input) {
        return { content: [{ type: 'text', text: 'error: поле ввода не найдено' }] };
      }
      await input.click();
      await p.keyboard.press('Control+a');
      await p.keyboard.press('Delete');
      for (const ch of text) {
        await p.keyboard.type(ch);
        await sleep(rand(40, 110));
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    }
    if (option !== undefined) {
      let target = null;
      const n = Number(option);
      if (Number.isInteger(n) && n > 0) {
        target = p
          .locator('input[type="radio"], [role="radio"], input[type="checkbox"], [role="checkbox"]')
          .nth(n - 1);
      } else {
        target = p
          .locator(`label:has-text("${option}"), [role="radio"]:has-text("${option}")`)
          .first();
      }
      try {
        await target.click({ timeout: 3000 });
        return { content: [{ type: 'text', text: 'ok' }] };
      } catch {
        return { content: [{ type: 'text', text: 'error: вариант не найден' }] };
      }
    }
    return { content: [{ type: 'text', text: 'error: нужен option или text' }] };
  }
);

server.tool(
  'next_task',
  'Перейти к следующей карточке. Возвращает done, если карточки закончились',
  {},
  async () => {
    const p = await getPage();
    const clicked = await clickButtonByText(p, NEXT_BUTTON_TEXTS);
    if (!clicked) return { content: [{ type: 'text', text: 'done' }] };
    await sleep(2000);
    return { content: [{ type: 'text', text: 'ok' }] };
  }
);

server.tool(
  'screenshot',
  'Сделать снимок текущей карточки в server/tmp/ и вернуть путь к файлу',
  {},
  async () => {
    const p = await getPage();
    const file = path.join(TMP_DIR, `shot-${Date.now()}.png`);
    await p.screenshot({ path: file });
    return { content: [{ type: 'text', text: file }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
