// Copy the verified submission PDF. Never regenerate it from browser HTML.
// Usage: npm run export:deck -- /path/to/submission.pdf
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(frontend, 'src/deck/presentation.json'), 'utf8'));
const source = resolve(frontend, '../docs/TwinOps_Deck.pdf');
const argument = process.argv[2];
if (process.argv.length > 3 || argument?.includes('://')) {
  throw new Error('Usage: npm run export:deck -- /path/to/submission.pdf. This copies the canonical PDF; it does not print a URL.');
}
const out = argument ? resolve(argument) : resolve(frontend, '../.local/TwinOps_Deck.pdf');
const bytes = await readFile(source);
if (createHash('sha256').update(bytes).digest('hex') !== manifest.pdfSha256) {
  throw new Error('Submission PDF differs from the web-deck manifest. Refresh and verify the slide assets first.');
}
if (out === source) {
  console.log('The submission PDF is already at the requested path and matches the deck manifest.');
} else {
  await mkdir(dirname(out), { recursive: true });
  await copyFile(source, out);
  console.log(`Verified submission PDF copied to ${out}`);
}
