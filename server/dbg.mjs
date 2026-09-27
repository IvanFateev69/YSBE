import { chromium } from 'playwright';
import fs from 'node:fs';
// подключаемся к уже запущенному браузеру нельзя — MCP держит профиль.
// вместо этого читаем через CDP: найдём порт
console.log('skip');
