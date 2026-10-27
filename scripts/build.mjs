import { mkdir, readdir, rm, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const name of await readdir('dist')) await rm(`dist/${name}`, { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.mjs', 'feed.mjs']) await copyFile(name, `dist/${name}`);
console.log('Built 4 static assets; runtime data and configuration excluded.');
