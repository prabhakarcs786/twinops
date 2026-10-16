// Detect drift between the editable deck, submitted PDF and deployed slide images.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(frontend, 'src/deck/presentation.json'), 'utf8'));
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
for (const [filename, expected] of [['TwinOps_Deck.pptx', manifest.pptxSha256], ['TwinOps_Deck.pdf', manifest.pdfSha256]]) {
  if (await digest(resolve(frontend, '../docs', filename)) !== expected) throw new Error(`${filename} differs from the web deck. Regenerate the slide assets and manifest.`);
}
if (manifest.slides.length !== 13) throw new Error('Expected 13 official-template slides.');
for (const [index, slide] of manifest.slides.entries()) {
  if (slide.number !== index + 1 || !slide.title || !slide.alt || !slide.paragraphs.length) throw new Error(`Missing slide ${index + 1} metadata or accessible explanation.`);
  if (!/^\/deck-assets\/slide-\d{2}-[a-f\d]{12}\.webp$/.test(slide.image)) throw new Error('Invalid slide asset path.');
  if (await digest(resolve(frontend, 'public', slide.image.slice(1))) !== slide.sha256) throw new Error(`Slide ${slide.number} differs from the manifest.`);
}
console.log('Verified 13 slide images, accessible explanations, submission PDF and editable PowerPoint.');
