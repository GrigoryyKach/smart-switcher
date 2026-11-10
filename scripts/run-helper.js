// Запускает хелпер в тестовом режиме и выводит его stdout (у winexe нет своей консоли).
const { spawn } = require('child_process');
const path = require('path');

const exe = path.resolve(__dirname, '..', 'helper', 'bin', 'SmartSwitcherHelper.exe');
const child = spawn(exe, process.argv.slice(2), { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.setEncoding('utf8');
child.stdout.on('data', d => process.stdout.write(d));
child.on('exit', code => process.exit(code ?? 1));
